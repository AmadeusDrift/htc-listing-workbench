import { canRetryConfirmedForbidden } from '../src/main/ai/confirmed-forbidden-retry.ts';
import { fieldGroupRetryScope } from '../src/main/ai/field-purpose-groups.ts';
import { join } from 'node:path';
import { readFileSync,writeFileSync } from 'node:fs';
import { createWorkspaceBackup,prepareWorkspaceRestore } from '../src/main/backup.ts';
import { openDatabase } from '../src/main/database.ts';
import { AiService } from '../src/main/ai/service.ts';
import { ListingAiService } from '../src/main/listing-ai/service.ts';
import { mockStorage } from './fixtures/listing-ai.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixtures/listing-ai.ts';
import { taskAiContext } from '../src/main/ai/batch/task-context.ts';
import { assertFieldGroupHistory } from '../src/main/ai/field-purpose-groups.ts';
import { assertCompletionHistory } from '../src/main/listing-ai/completion-journal.ts';

const continuation = <T>(f:{product:{id:string};draft:{variantId:string}},run:()=>Promise<T>) => taskAiContext.run({taskId:randomUUID(),rowKey:f.product.id+':'+f.draft.variantId,phase:'FIELDS',mode:'immediate',explicitContinueAt:new Date(Date.now()+1000).toISOString(),authorize:()=>true},run);
async function grouped(t:any, first=false){
 const f=await fixture(t),transport=(f.ai as any).context,fetcher=transport.fetch;
 f.ai.saveConnection({id:'openrouter',apiKey:'synthetic-group-key'});f.ai.setEnabled({id:'openrouter',enabled:true});
 const purpose=first?'listing_generation':'listing_title',p=f.ai.getPurposeProfiles().find(p=>p.purposeId===purpose)!;
 f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-astra',effort:'high'}});
 let forbidden=true,posts=0;
 transport.fetch=async(url:any,init:any)=>{posts++;if(forbidden&&JSON.parse(init.body).model==='openai/gpt-6-astra')return new Response(JSON.stringify({error:{code:403,message:'This model is not available in your region.'}}),{status:403});return fetcher(url,init);};
 return {...f,posts:()=>posts,allow:()=>{forbidden=false;},db:(f.ai as any).db};
}

test('confirmed403 grouped continuation retries failed member once and preserves successful siblings',async t=>{
 const f=await grouped(t);await assert.rejects(f.listing.suggest(f.reference));const calls=f.ai.listCalls(),parts=f.ai.listResults(f.product.id);assert.equal(f.posts(),2);
 await assert.rejects(f.listing.suggest(f.reference));assert.equal(f.posts(),2);
 f.allow();const result=await continuation(f,()=>f.listing.suggest(f.reference));assert.equal(f.posts(),3);assert.ok(result.fieldGroupAssembly);
 for(const call of calls)assert.deepEqual(f.ai.getCall(call.id),call);for(const part of parts)assert.deepEqual(f.ai.getResult(part.id),part);
 assertFieldGroupHistory(f.db);assert.equal((await continuation(f,()=>f.listing.suggest(f.reference))).id,result.id);assert.equal(f.posts(),3);
});

test('confirmed403 grouped second403 stops even after new continuation context',async t=>{
 const f=await grouped(t);await assert.rejects(f.listing.suggest(f.reference));await assert.rejects(continuation(f,()=>f.listing.suggest(f.reference)));assert.equal(f.posts(),3);
 f.allow();await assert.rejects(continuation(f,()=>f.listing.suggest(f.reference)));assert.equal(f.posts(),3);assertFieldGroupHistory(f.db);
});

test('confirmed403 first grouped member keeps completion operation identity and valid result owner',async t=>{
 const f=await grouped(t),persistence=(f.amazon as any).persistence,record=persistence.record(f.draft.id);delete record.draft.attributes.item_name;delete record.draft.attributes.product_description;persistence.putRecord(record);
 // Make the first completion group OpenRouter; title remains separately configured on the same model, description stays DeepSeek.
 for(const purposeId of ['listing_completion']){const p=f.ai.getPurposeProfiles().find(p=>p.purposeId===purposeId)!;f.ai.savePurposeProfile({purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-astra',effort:'high'}});}
 f.amazon.previewDraft=async()=>{const d=f.amazon.getDraft(f.draft.id),missing=['item_name','product_description'].filter(k=>!d.attributes[k]);return{...d,state:missing.length?'BLOCKED':'AMAZON_VALIDATED',previewIssues:missing.map(field=>({code:'MISSING',message:'Missing '+field,severity:'ERROR',category:'field',source:'amazon',attributeNames:[field],autoFixable:false}))};};
 await assert.rejects(f.listing.complete(f.reference));const op=f.listing.completionOperations(f.draft.id)[0],id=op.rounds[0].candidate.id;assert.equal(f.posts(),1);
 f.allow();const result=await continuation(f,()=>f.listing.complete(f.reference));assert.deepEqual(result.remaining,[]);const updated=f.listing.completionOperations(f.draft.id)[0];assert.equal(updated.id,op.id);assert.equal(updated.rounds[0].candidate.id,id);assertFieldGroupHistory(f.db);assertCompletionHistory(f.db);
});

for(const damage of ['missing','tampered'])test(`group403 ${damage} receipt cannot authorize a retry`,async t=>{
 const f=await grouped(t);await assert.rejects(f.listing.suggest(f.reference));const rejected=f.ai.listCalls().find(c=>c.errorCode==='MODEL_REGION_RESTRICTED')!;
 if(damage==='missing')f.db.prepare('DELETE FROM ai_provider_receipts WHERE id=?').run(rejected.providerReceiptId);
 else{const row=f.db.prepare('SELECT record_json FROM ai_provider_receipts WHERE id=?').get(rejected.providerReceiptId),meta=JSON.parse(String(row.record_json)),path=join(f.directory,meta.relativePath);writeFileSync(path,readFileSync(path,'utf8').replace('This model','That model'));}
 f.allow();await assert.rejects(continuation(f,()=>f.listing.suggest(f.reference)));assert.equal(f.posts(),2);
});

test('group403 restore old backup keeps original and retry calls, spent ledger and one-shot claim',async t=>{
 const f=await grouped(t);await assert.rejects(f.listing.suggest(f.reference));const backup=join(f.directory,'before-retry.htcbackup');await createWorkspaceBackup(f.directory,backup,'synthetic 403 grouped rollback');
 await assert.rejects(continuation(f,()=>f.listing.suggest(f.reference)));assert.equal(f.posts(),3);
 const prepared=await prepareWorkspaceRestore(f.directory,backup,'synthetic 403 grouped rollback'),db=openDatabase(prepared.stagingDirectory);
 try{assertFieldGroupHistory(db);const group=JSON.parse(String(db.prepare('SELECT record_json FROM ai_field_groups').get()!.record_json));assert.ok(group.members[1].retryCallId);assert.ok(db.prepare('SELECT 1 FROM ai_calls WHERE id=?').get(group.members[1].callId));assert.ok(db.prepare('SELECT 1 FROM ai_calls WHERE id=?').get(group.members[1].retryCallId));assert.equal(db.prepare("SELECT count(*) n FROM audit_events WHERE action='ai.forbidden.manual-retry'").get()!.n,1);assert.equal(db.prepare('SELECT count(*) n FROM ai_usage_ledger').get()!.n,3);const original=JSON.parse(String(db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(group.members[1].callId)!.record_json));assert.equal(await continuation(f,async()=>canRetryConfirmedForbidden(db,original,fieldGroupRetryScope(group,group.members[1]))),false);}finally{db.close();}
});

test('group403 restart after second refusal cannot obtain another request',async t=>{
 const f=await grouped(t);await assert.rejects(f.listing.suggest(f.reference));await assert.rejects(continuation(f,()=>f.listing.suggest(f.reference)));assert.equal(f.posts(),3);await f.ai.close();
 let posts=0;const ai=new AiService(f.directory,f.store,f.hosting,mockStorage,{fetch:async()=>{posts++;throw Error('unexpected request');}}),listing=new ListingAiService(f.store,f.amazon,ai);
 try{await assert.rejects(continuation(f,()=>listing.suggest(f.reference)));assert.equal(posts,0);assertFieldGroupHistory((ai as any).db);}finally{await ai.close();}
});

test('group403 original usage budget blocks retry without consuming its one-shot claim',async t=>{
 const f=await grouped(t);await assert.rejects(f.listing.suggest(f.reference));
 const usage=(f.ai as any).usage,reserve=usage.reserve.bind(usage);usage.reserve=()=>{throw Error('synthetic original budget exhausted');};
 await assert.rejects(continuation(f,()=>f.listing.suggest(f.reference)));assert.equal(f.posts(),2);assert.equal(f.db.prepare("SELECT count(*) n FROM audit_events WHERE action='ai.forbidden.manual-retry'").get().n,0);
 usage.reserve=reserve;f.allow();await continuation(f,()=>f.listing.suggest(f.reference));assert.equal(f.posts(),3);
});

test('group403 retry ownership cannot point at a sibling or forged result call',async t=>{
 const f=await grouped(t);await assert.rejects(f.listing.suggest(f.reference));f.allow();const result=await continuation(f,()=>f.listing.suggest(f.reference));
 const row=f.db.prepare('SELECT record_json FROM ai_field_groups').get(),group=JSON.parse(String(row.record_json)),original=JSON.stringify(group);
 group.members[1].retryCallId=group.members[0].callId;f.db.prepare('UPDATE ai_field_groups SET record_json=? WHERE id=?').run(JSON.stringify(group),group.id);assert.throws(()=>assertFieldGroupHistory(f.db));
 f.db.prepare('UPDATE ai_field_groups SET record_json=? WHERE id=?').run(original,group.id);
 const stored=f.ai.getResult(result.fieldGroupAssembly!.sources[1].id)!;f.db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify({...stored,callId:group.members[1].callId}),stored.id);assert.throws(()=>assertFieldGroupHistory(f.db));
});
