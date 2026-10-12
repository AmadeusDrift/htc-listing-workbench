import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture, saveInput } from './fixtures/listing-ai.ts';
import { assertListingHistory } from '../src/main/listing-ai/history.ts';
import { openDatabase } from '../src/main/database.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import type { AmazonPersistence } from '../src/main/amazon/persistence.ts';
import { createHash } from 'node:crypto';
import { buildListingContext } from '../src/main/listing-ai/context.ts';
import { currentDraftEvidenceIssues } from '../src/main/listing-ai/current-evidence.ts';

async function adoptedFixture(t:test.TestContext) {
 const f=await fixture(t),suggestion=await f.listing.suggest(f.reference),review=await f.listing.review({...f.reference,suggestionResultId:suggestion.id});
 const adopted=await f.listing.adopt({...f.reference,suggestionResultId:suggestion.id,reviewResultId:review.id,fields:['material']});
 const persistence=(f.amazon as unknown as {persistence:AmazonPersistence}).persistence;
 const results=new Map(f.ai.listResults(f.product.id).map(r=>[r.id,r])),calls=new Map(f.ai.listCalls().map(c=>[c.id,c]));
 const adapt=()=>{const source=f.store.getProductSnapshot(f.product.id),input=saveInput(source);const next=f.store.saveProduct({...input,variants:input.variants.map(v=>({...v,purchasePrice:String(Number(v.purchasePrice||0)+1)}))});
  return persistence.transaction(()=>f.amazon.applyTaskAdaptation(adopted.id,next,undefined,persistence.db));};
 return {...f,adopted,persistence,results,calls,adapt};
}
test('W2 real adopted fields survive source adaptation, rollback, repeat adaptation and backup without rewriting evidence',async t=>{
 const f=await adoptedFixture(t),db=f.persistence.db,original=JSON.stringify(f.adopted.fieldAdoptions),results=JSON.stringify([...f.results]);
 const baseline=JSON.stringify(f.persistence.record(f.adopted.id));
 const source=f.store.getProductSnapshot(f.product.id);source.revision++;
 db.exec('BEGIN IMMEDIATE');f.amazon.applyTaskAdaptation(f.adopted.id,source,undefined,db);db.exec('ROLLBACK');
 assert.equal(JSON.stringify(f.persistence.record(f.adopted.id)),baseline);assert.equal(db.prepare("SELECT count(*) n FROM audit_events WHERE action='listing.task-adapted'").get()!.n,0);
 const first=f.adapt();assert.doesNotThrow(()=>assertListingHistory(first,f.results,f.calls,db));
 const latest=f.adapt();assert.doesNotThrow(()=>assertListingHistory(latest,f.results,f.calls,db));
 assert.throws(()=>assertListingHistory(latest,f.results,f.calls));assert.equal(JSON.stringify(latest.fieldAdoptions),original);assert.equal(JSON.stringify([...f.results]),results);
 const backup=join(f.directory,'adaptation.htcbackup'),directory=join(f.directory,'restored');
 await createWorkspaceBackup(f.directory,backup,'isolated adaptation passphrase');const prepared=await prepareWorkspaceRestore(directory,backup,'isolated adaptation passphrase');await commitWorkspaceRestore(directory,prepared);
 const restored=openDatabase(directory);try{const record=JSON.parse(String(restored.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(latest.id)!.record_json));assert.equal(JSON.stringify(record.draft.fieldAdoptions),original);assert.doesNotThrow(()=>assertListingHistory(record.draft,f.results,f.calls,restored));}finally{restored.close();}
});

test('later adoption across two source transitions keeps every original context; changed material remains blocked now',async t=>{
 const f=await adoptedFixture(t),first=f.adapt(),ref={draftId:first.id,draftRevision:first.revision};
 const suggestion=await f.listing.suggest(ref),review=await f.listing.review({...ref,suggestionResultId:suggestion.id});
 const middle=await f.listing.adopt({...ref,suggestionResultId:suggestion.id,reviewResultId:review.id,fields:['color']});
 const frozen=JSON.stringify(middle.fieldAdoptions),latest=f.adapt();
 const results=new Map(f.ai.listResults(f.product.id).map(r=>[r.id,r])),calls=new Map(f.ai.listCalls().map(c=>[c.id,c]));
 assert.equal(JSON.stringify(latest.fieldAdoptions),frozen);assert.doesNotThrow(()=>assertListingHistory(latest,results,calls,f.persistence.db));
 for(const value of ['Silicone','未知复合材料','硅胶与新型纤维复合']){const equivalent=f.store.getProductSnapshot(f.product.id);equivalent.facts.find(f=>f.name==='材质')!.value=value;equivalent.facts.push({...equivalent.facts[0],id:'unrelated-fact',name:'备注',value:'new ordinary source information'});
  assert.deepEqual(currentDraftEvidenceIssues(latest,buildListingContext(latest,equivalent,0),id=>results.get(id)),[],value);}
 const source=f.store.getProductSnapshot(f.product.id);source.facts.find(f=>f.name==='材质')!.value='不锈钢';
 const changed=f.persistence.transaction(()=>f.amazon.applyTaskAdaptation(latest.id,{...source,revision:source.revision+1},undefined,f.persistence.db));
 assert.doesNotThrow(()=>assertListingHistory(changed,results,calls,f.persistence.db));
 const context=buildListingContext(changed,{...source,revision:changed.productRevision},0);
 assert.ok(currentDraftEvidenceIssues(changed,context,id=>results.get(id)).some(issue=>issue.includes('material')));
});

test('schema refresh through source adapter decodes original wrapper using its recorded schema',async t=>{
 const f=await adoptedFixture(t),schema=structuredClone(f.adopted.schema);schema.version+='-new';schema.checksum='updated-schema';schema.fetchedAt=new Date(Date.parse(schema.fetchedAt)+1000).toISOString();
 const material=(schema.schema.properties as any).material.items;material.properties.language_tag={type:'string'};
 f.persistence.putSchema(schema);const latest=f.adapt();assert.equal(latest.schema.checksum,'updated-schema');
 assert.doesNotThrow(()=>assertListingHistory(latest,f.results,f.calls,f.persistence.db));
});

for(const kind of ['missing','legacy','duplicate','hash','identity','revision','source','schema','events','history','response','attributes'] as const)test(`source lineage refuses tampered proof: ${kind}`,async t=>{
 const f=await adoptedFixture(t),latest=f.adapt(),db=f.persistence.db,row=db.prepare("SELECT id,detail_json FROM audit_events WHERE action='listing.task-adapted'").get()!,proof=JSON.parse(String(row.detail_json));
 if(kind==='legacy')delete proof.version;
 if(kind==='hash')proof.beforeSha256='0'.repeat(64);
 if(kind==='identity')proof.beforeRecord.draft.sku='forged';
 if(kind==='revision')proof.afterRecord.draft.revision++;
 if(kind==='source')proof.afterRecord.draft.productRevision++;
 if(kind==='schema')proof.afterRecord.draft.schema.version+='forged';
 if(kind==='events')proof.afterRecord.draft.events.pop();
 if(kind==='history')proof.beforeRecord.draft.fieldAdoptions=[];
 if(kind==='response')proof.afterRecord.previewResponse={forged:true};
 if(kind==='attributes')proof.afterRecord.draft.attributes.material=[{value:'Steel'}];
 if(!['legacy','hash'].includes(kind)){proof.before=proof.beforeRecord.draft;for(const name of ['before','after'])proof[name+'Sha256']=createHash('sha256').update(JSON.stringify(proof[name+'Record'])).digest('hex');}
 db.prepare('UPDATE audit_events SET detail_json=? WHERE id=?').run(JSON.stringify(proof),row.id);
 if(kind==='missing')db.prepare('DELETE FROM audit_events WHERE id=?').run(row.id);
 if(kind==='duplicate')db.prepare("INSERT INTO audit_events SELECT 'duplicate',product_id,action,summary,detail_json,created_at FROM audit_events WHERE id=?").run(row.id);
 assert.throws(()=>assertListingHistory(latest,f.results,f.calls,db));
});
