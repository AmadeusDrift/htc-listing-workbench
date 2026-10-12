import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/listing-ai.ts';
import { AmazonPersistence } from '../src/main/amazon/persistence.ts';
import { ListingCorrections } from '../src/main/amazon/corrections.ts';
import { listingHash } from '../src/main/amazon/context.ts';
import type { JsonObject } from '../src/shared/amazon-contracts.ts';
import {openDatabase} from '../src/main/database.ts';
import {retainCorrectionHistory,assertCorrectionHistory,invalidateCorrectionAuthorizations} from '../src/main/amazon/correction-history.ts';
import {join} from 'node:path';
import {createWorkspaceBackup,prepareWorkspaceRestore,commitWorkspaceRestore} from '../src/main/backup.ts';

const ref=(c:{id:string;revision:number;patchHash:string})=>({id:c.id,revision:c.revision,patchHash:c.patchHash});
async function setup(t:test.TestContext){
 const f=await fixture(t);const p=(f.amazon as unknown as {persistence:AmazonPersistence}).persistence;
 const r=p.record(f.draft.id);r.draft.mode='live';r.draft.submittedAt=new Date().toISOString();r.draft.state='SUBMITTED';r.draft.submissionId='original';r.submitResponse={sku:r.draft.sku,status:'ACCEPTED',submissionId:'original',issues:[]};
 r.draft.schema.schema={type:'object',properties:{package_level:{type:'array'},package_contains_sku:{type:'array',selectors:['marketplace_id','sku']}},additionalProperties:true};r.draft.schema.metaSchema={};r.draft.schema.mode='live';
 r.draft.attributes={package_level:[{value:'unit',marketplace_id:r.draft.marketplaceId}],package_contains_sku:[{sku:r.draft.sku,marketplace_id:r.draft.marketplaceId,quantity:1}]};r.request={productType:r.draft.schema.productType,attributes:r.draft.attributes};p.putRecord(r);
 const target={...p.target(r.draft.targetId),mode:'live' as const,paused:false};p.putTarget(target);
 let remote:JsonObject={sku:r.draft.sku,summaries:[{marketplaceId:r.draft.marketplaceId,productType:r.draft.schema.productType}],attributes:structuredClone(r.draft.attributes),issues:[]};let sends=0;let unknown=false;let rejected=false;let previewError=false;
 const service=new ListingCorrections(p,{active:()=>target,schema:async()=>r.draft.schema,api:async(_target,op,_path,_query,body,guard)=>{guard?.();if(op==='getListingsItem')return {data:structuredClone(remote),status:200,requestId:'read'};if(op==='previewPatchListingsItem')return {data:{sku:r.draft.sku,status:previewError?'INVALID':'VALID',issues:previewError?[{severity:'ERROR',code:'preview-error',message:'Preview rejected'}]:[]},status:200,requestId:'preview'};sends++;if(unknown)throw new Error('lost');assert.equal((body as any)?.patches?.[0]?.op,'delete');return {data:(rejected?{sku:r.draft.sku,status:'INVALID',issues:[{severity:'ERROR',code:'test',message:'Submission rejected'}]}:{sku:r.draft.sku,status:'ACCEPTED',submissionId:'correction',issues:[]}) as JsonObject,status:200,requestId:'patch'};}});
 return {f,p,r,service,target,get sends(){return sends;},previewError(){previewError=true;},reject(){rejected=true;},remote:(value:JsonObject)=>{remote=value;},remove(){delete (remote.attributes as JsonObject).package_contains_sku;remote.issues=[{code:'8031',message:'remaining issue'}];},unknown(){unknown=true;},change(){(remote.attributes as JsonObject).other='changed';}};
}
test('original-SKU narrow prepare preview send readback preserves original record and sends once',async t=>{
 const f=await setup(t),before=JSON.stringify(f.p.record(f.r.draft.id));
 const prepared=await f.service.prepare({id:f.r.draft.id,revision:f.r.draft.revision});assert.equal(prepared.state,'PREPARED');assert.equal(f.sends,0);
 const ready=await f.service.preview(ref(prepared));assert.equal(ready.state,'READY');
 await assert.rejects(f.service.send(ref(ready),false));
 const results=await Promise.allSettled([f.service.send(ref(ready),true),f.service.send(ref(ready),true)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.sends,1);
 const accepted=f.service.get(ready.id);assert.equal(accepted.state,'ACCEPTED');const hash=listingHash(f.r.draft,f.r.draft.sku);
 f.p.releaseAccepted(hash,f.r.draft.id);assert.equal(f.p.lock(hash)?.ownerKind,'correction');const late=structuredClone(f.r);late.unresolvedWrite=true;late.draft.state='UNKNOWN';late.submitResponse={status:'lost'};f.p.finishWrite(hash,late);assert.equal(f.p.lock(hash)?.ownerKind,'correction');assert.equal(f.p.lock(hash)?.state,'ACCEPTED');assert.throws(()=>f.p.beginWrite(hash,{...f.r,draft:{...f.r.draft,id:'alias'}}));
 f.remove();const verified=await f.service.readback(ref(accepted));assert.equal(verified.state,'VERIFIED');assert.equal(verified.remainingIssues.length,1);assert.equal(f.p.lock(hash),null);
 assert.equal(JSON.stringify(f.p.record(f.r.draft.id)),before);await assert.rejects(f.service.send(ref(ready),true));
});
test('separate service instances cannot overwrite the winner with stale send failure',async t=>{
 const f=await setup(t),ready=await f.service.preview(ref(await f.service.prepare({id:f.r.draft.id,revision:f.r.draft.revision}))),second=new ListingCorrections(f.p,(f.service as any).hooks);
 const outcomes=await Promise.allSettled([f.service.send(ref(ready),true),second.send(ref(ready),true)]);
 assert.equal(f.sends,1);assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);assert.equal(f.service.get(ready.id).state,'ACCEPTED');assert.equal(f.p.lock(ready.listingHash)?.state,'ACCEPTED');
});
test('missing attributes and wrong identity cannot verify removal; credential rotation blocks READY sends',async t=>{
 const f=await setup(t),ready=await f.service.preview(ref(await f.service.prepare({id:f.r.draft.id,revision:f.r.draft.revision}))),accepted=await f.service.send(ref(ready),true);
 for(const value of [{sku:f.r.draft.sku,summaries:[{marketplaceId:f.r.draft.marketplaceId,productType:f.r.draft.schema.productType}]},{sku:'other',attributes:{},summaries:[]}]){f.remote(value as JsonObject);await assert.rejects(f.service.readback(ref(accepted)));assert.equal(f.service.get(accepted.id).state,'ACCEPTED');}
});
test('empty summary permits trusted submitted type with current PTD; conflicting metadata and cross-market attributes reject',async t=>{
 const f=await setup(t),base={sku:f.r.draft.sku,summaries:[],attributes:f.r.draft.attributes,issues:[]};
 for(const remote of [{...base,summaries:[{marketplaceId:f.r.draft.marketplaceId,productType:'OTHER'}]},{...base,productTypes:[{marketplaceId:f.r.draft.marketplaceId,productType:'OTHER'}]},{...base,summaries:null},{...base,attributes:{...base.attributes,other:[{marketplace_id:'OTHER'}]}}]){
  f.remote(remote as JsonObject);await assert.rejects(f.service.prepare({id:f.r.draft.id,revision:f.r.draft.revision}));
 }
 f.remote(base);const prepared=await f.service.prepare({id:f.r.draft.id,revision:f.r.draft.revision});assert.equal(prepared.state,'PREPARED');assert.match(prepared.typeEvidence,/原可信提交/);assert.equal(f.sends,0);
});
test('remote omission of untouched required field is diagnostic, but the submitted self edge must match exactly',async t=>{
 const f=await setup(t);f.r.draft.schema.schema.required=['operational'];(f.r.draft.schema.schema.properties as JsonObject).operational={type:'string'};f.r.draft.attributes.operational='retained';f.r.request.attributes=f.r.draft.attributes;f.p.putRecord(f.r);
 const before=structuredClone(f.r.draft.attributes);delete before.operational;
 f.remote({sku:f.r.draft.sku,summaries:[],attributes:{...before,package_contains_sku:[{sku:f.r.draft.sku,marketplace_id:f.r.draft.marketplaceId,quantity:2}]},issues:[]});await assert.rejects(f.service.prepare({id:f.r.draft.id,revision:f.r.draft.revision}),/不一致/);
 f.remote({sku:f.r.draft.sku,summaries:[],attributes:before,issues:[]});const prepared=await f.service.prepare({id:f.r.draft.id,revision:f.r.draft.revision});assert.equal(prepared.state,'PREPARED');assert.ok(prepared.remoteLocalIssues.length);assert.equal(prepared.after.operational,undefined);assert.deepEqual(Object.keys(prepared.request).sort(),['patches','productType']);assert.equal((await f.service.preview(ref(prepared))).state,'READY');
});
test('restoring old READY retains every sent terminal attempt even without original draft',async t=>{
 for(const state of ['UNKNOWN','ACCEPTED','VERIFIED','REJECTED'] as const)await t.test(state,async t=>{
  const f=await setup(t),ready=await f.service.preview(ref(await f.service.prepare({id:f.r.draft.id,revision:f.r.draft.revision}))),snapshot=openDatabase(join(f.f.directory,'snapshot'));
  try{
   snapshot.prepare('INSERT INTO listing_corrections VALUES(?,?,?,?)').run(ready.id,ready.draftId,ready.listingHash,JSON.stringify(ready));
   if(state==='UNKNOWN')f.unknown();if(state==='REJECTED')f.reject();let sent=await f.service.send(ref(ready),true);if(state==='VERIFIED'){f.remove();sent=await f.service.readback(ref(sent));}
   retainCorrectionHistory(f.p.db,snapshot);invalidateCorrectionAuthorizations(snapshot);assertCorrectionHistory(snapshot);
   const restored=JSON.parse(String(snapshot.prepare('SELECT record_json FROM listing_corrections WHERE id=?').get(ready.id)!.record_json));assert.equal(restored.state,state);assert.equal(snapshot.prepare('SELECT count(*) AS n FROM listing_correction_attempts').get()!.n,1);assert.equal(snapshot.prepare('SELECT count(*) AS n FROM listing_drafts').get()!.n,0);
   assert.equal(snapshot.prepare('SELECT count(*) AS n FROM amazon_write_locks').get()!.n,['UNKNOWN','ACCEPTED'].includes(state)?1:0);await assert.rejects(f.service.send(ref(ready),true));assert.equal(f.sends,1);
  }finally{snapshot.close();}
 });
});
test('encrypted backup revokes READY and merges newer sent journals into a workspace lacking the original draft',async t=>{
 const f=await setup(t),ready=await f.service.preview(ref(await f.service.prepare({id:f.r.draft.id,revision:f.r.draft.revision}))),file=join(f.f.directory,'correction.htcbackup'),destination=join(f.f.directory,'restore');
 await createWorkspaceBackup(f.f.directory,file,'correction fixture passphrase');f.unknown();await f.service.send(ref(ready),true);
 const current=openDatabase(destination);retainCorrectionHistory(f.p.db,current);current.close();
 await commitWorkspaceRestore(destination,await prepareWorkspaceRestore(destination,file,'correction fixture passphrase'));
 const restored=openDatabase(destination);try{assertCorrectionHistory(restored);assert.equal(JSON.parse(String(restored.prepare('SELECT record_json FROM listing_corrections WHERE id=?').get(ready.id)!.record_json)).state,'UNKNOWN');assert.equal(restored.prepare('SELECT count(*) AS n FROM listing_correction_attempts').get()!.n,1);}finally{restored.close();}
});
test('unknown never unlocks or resends even after relation disappears; stale remote blocks send',async t=>{
 const f=await setup(t),ready=await f.service.preview(ref(await f.service.prepare({id:f.r.draft.id,revision:f.r.draft.revision})));f.unknown();const unknown=await f.service.send(ref(ready),true);assert.equal(unknown.state,'UNKNOWN');f.remove();
 assert.equal((await f.service.readback(ref(unknown))).state,'UNKNOWN');assert.ok(f.p.lock(listingHash(f.r.draft,f.r.draft.sku)));await assert.rejects(f.service.send(ref(ready),true));assert.equal(f.sends,1);
});
test('READY requires unchanged baseline and renderer cannot supply patches',async t=>{
 const f=await setup(t),ready=await f.service.preview(ref(await f.service.prepare({id:f.r.draft.id,revision:f.r.draft.revision})));f.change();await assert.rejects(f.service.send(ref(ready),true));assert.equal(f.sends,0);assert.equal(f.service.get(ready.id).state,'STALE');
 await assert.rejects(f.service.send({...ready,patches:[]},true));
});
test('generation changes revoke READY but same-identity readback after reauthorization keeps UNKNOWN locked',async t=>{
 const f=await setup(t),ready=await f.service.preview(ref(await f.service.prepare({id:f.r.draft.id,revision:f.r.draft.revision})));
 f.p.putTarget(f.target,true);await assert.rejects(f.service.send(ref(ready),true));assert.equal(f.sends,0);assert.equal(f.service.get(ready.id).state,'STALE');
 const next=await f.service.preview(ref(await f.service.prepare({id:f.r.draft.id,revision:f.r.draft.revision})));f.unknown();const unknown=await f.service.send(ref(next),true);f.p.putTarget(f.target,true);f.remove();assert.equal((await f.service.readback(ref(unknown))).state,'UNKNOWN');assert.ok(f.p.lock(next.listingHash));
});
test('restart converts SENDING to UNKNOWN without modifying original submitted record or resending',async t=>{
 const f=await setup(t),ready=await f.service.preview(ref(await f.service.prepare({id:f.r.draft.id,revision:f.r.draft.revision})));f.unknown();const unknown=await f.service.send(ref(ready),true),before=JSON.stringify(f.p.record(f.r.draft.id));
 f.p.db.prepare("UPDATE listing_corrections SET record_json=json_set(record_json,'$.state','SENDING') WHERE id=?").run(unknown.id);f.p.db.prepare("UPDATE listing_correction_attempts SET record_json=json_set(record_json,'$.state','SENDING') WHERE correction_id=?").run(unknown.id);f.p.db.prepare("UPDATE amazon_write_locks SET state='SENDING' WHERE listing_hash=?").run(unknown.listingHash);
 f.p.recover(new Date().toISOString());assert.equal(f.service.get(unknown.id).state,'UNKNOWN');assert.equal(f.p.lock(unknown.listingHash)?.state,'UNKNOWN');assert.equal(JSON.stringify(f.p.record(f.r.draft.id)),before);await assert.rejects(f.service.send(ref(ready),true));assert.equal(f.sends,1);
});

test('preview ERROR never authorizes sending and a changed current PTD invalidates READY',async t=>{
 const f=await setup(t);f.previewError();const rejected=await f.service.preview(ref(await f.service.prepare({id:f.r.draft.id,revision:f.r.draft.revision})));assert.equal(rejected.state,'REJECTED');await assert.rejects(f.service.send(ref(rejected),true));assert.equal(f.sends,0);
 const g=await setup(t),ready=await g.service.preview(ref(await g.service.prepare({id:g.r.draft.id,revision:g.r.draft.revision})));g.r.draft.schema.version='changed';await assert.rejects(g.service.send(ref(ready),true));assert.equal(g.service.get(ready.id).state,'STALE');assert.equal(g.sends,0);
});
test('preview in-flight changes cannot authorize READY',async t=>{
 for(const change of ['generation','baseline','schema','original'] as const)await t.test(change,async t=>{
  const f=await setup(t),prepared=await f.service.prepare({id:f.r.draft.id,revision:f.r.draft.revision}),hooks=(f.service as any).hooks,api=hooks.api;
  hooks.api=async(...args:any[])=>{const result=await api(...args);if(args[1]==='previewPatchListingsItem'){
   if(change==='generation')f.p.putTarget(f.target,true);if(change==='baseline')f.change();if(change==='schema')f.r.draft.schema.version='changed';if(change==='original'){f.r.draft.revision++;f.p.putRecord(f.r);}
  }return result;};
  await assert.rejects(f.service.preview(ref(prepared)));assert.equal(f.service.get(prepared.id).state,'STALE');assert.equal(f.sends,0);
 });
});
test('unreadable relationship entries preserve observations and ACCEPTED or UNKNOWN locks',async t=>{
 for(const state of ['ACCEPTED','UNKNOWN'] as const)await t.test(state,async t=>{
  const f=await setup(t),ready=await f.service.preview(ref(await f.service.prepare({id:f.r.draft.id,revision:f.r.draft.revision})));if(state==='UNKNOWN')f.unknown();let c=await f.service.send(ref(ready),true);
  for(const edges of [[null],[{}],[{marketplace_id:f.r.draft.marketplaceId}],[{sku:'OTHER'}],{sku:'OTHER'}] as any[]){
   const remote={sku:f.r.draft.sku,summaries:[],attributes:{package_contains_sku:edges},issues:[]};f.remote(remote);c=await f.service.readback(ref(c));
   assert.equal(c.state,state);assert.deepEqual(c.readback,remote);assert.match(c.message,/无法核实/);assert.equal(f.p.lock(c.listingHash)?.ownerId,c.id);assert.equal(f.p.lock(c.listingHash)?.state,state);
  }
  f.remote({sku:f.r.draft.sku,summaries:[],attributes:{package_contains_sku:[]},issues:[]});c=await f.service.readback(ref(c));assert.equal(c.state,state==='UNKNOWN'?'UNKNOWN':'VERIFIED');assert.equal(!!f.p.lock(c.listingHash),state==='UNKNOWN');assert.equal(f.sends,1);
 });
});
test('restored old ACCEPTED lock clears only for the identical verified or rejected terminal owner',async t=>{
 for(const state of ['VERIFIED','REJECTED'] as const)for(const conflict of ['none','owner','identity','request'] as const)await t.test(state+' '+conflict,async t=>{
  const f=await setup(t),ready=await f.service.preview(ref(await f.service.prepare({id:f.r.draft.id,revision:f.r.draft.revision}))),snapshot=openDatabase(join(f.f.directory,'snapshot-lock'));
  try{
   if(state==='REJECTED')f.reject();let terminal=await f.service.send(ref(ready),true);if(state==='VERIFIED'){f.remove();terminal=await f.service.readback(ref(terminal));}
   const old={...terminal,state:'ACCEPTED',revision:terminal.revision-1};if(conflict==='identity')old.sku='OTHER';if(conflict==='request')old.patchHash='other-hash';
   snapshot.prepare('INSERT INTO listing_corrections VALUES(?,?,?,?)').run(old.id,old.draftId,old.listingHash,JSON.stringify(old));
   snapshot.prepare("INSERT INTO amazon_write_locks(listing_hash,draft_id,state,created_at,owner_kind,owner_id) VALUES(?,?,'ACCEPTED',?,'correction',?)").run(old.listingHash,old.draftId,old.createdAt,conflict==='owner'?'other-correction':old.id);
   retainCorrectionHistory(f.p.db,snapshot);const lock=snapshot.prepare('SELECT * FROM amazon_write_locks WHERE listing_hash=?').get(old.listingHash),merged=JSON.parse(String(snapshot.prepare('SELECT record_json FROM listing_corrections WHERE id=?').get(old.id)!.record_json));
   if(conflict==='none'){assert.equal(lock,undefined);assert.equal(merged.state,state);}else{assert.ok(lock);assert.equal(lock.state,'UNKNOWN');assert.equal(merged.state,'UNKNOWN');if(conflict==='owner')assert.equal(lock.owner_id,'other-correction');}
   assert.equal(snapshot.prepare('SELECT count(*) AS n FROM listing_correction_attempts').get()!.n,1);
  }finally{snapshot.close();}
 });
});
test('malformed issue objects cannot authorize preview or mark a formal response accepted',async t=>{
 for(const operation of ['previewPatchListingsItem','patchListingsItem'] as const)await t.test(operation,async t=>{
  const f=await setup(t),hooks=(f.service as any).hooks,base=hooks.api,prepared=await f.service.prepare({id:f.r.draft.id,revision:f.r.draft.revision});
  hooks.api=async(...args:any[])=>{const result=await base(...args);if(args[1]===operation)result.data.issues=[null];return result;};
  const preview=await f.service.preview(ref(prepared));if(operation==='previewPatchListingsItem'){assert.equal(preview.state,'REJECTED');assert.equal(f.sends,0);}else{const sent=await f.service.send(ref(preview),true);assert.equal(sent.state,'UNKNOWN');assert.equal(f.p.lock(sent.listingHash)?.state,'UNKNOWN');assert.equal(f.sends,1);}
 });
});
