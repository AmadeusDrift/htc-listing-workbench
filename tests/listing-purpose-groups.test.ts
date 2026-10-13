import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,chat,candidateFor } from './fixtures/listing-ai.ts';
import { join } from 'node:path';
import { createWorkspaceBackup,prepareWorkspaceRestore } from '../src/main/backup.ts';
import { openDatabase } from '../src/main/database.ts';
import { assertFieldGroupHistory } from '../src/main/ai/field-purpose-groups.ts';
import { createHash } from 'node:crypto';

test('A43 different title and description configurations send distinct real calls and assemble attributed results',async t=>{
  const f=await fixture(t),requests:{model:string;effort:unknown;fields:string[]}[]=[],transport=(f.ai as any).context,fetcher=transport.fetch;
  transport.fetch=async(url:any,init:any)=>{const body=JSON.parse(init.body),payload=JSON.parse(body.messages[1].content);requests.push({model:body.model,effort:body.reasoning?.effort??body.reasoning_effort??'none',fields:payload.fields.map((v:any)=>v.name)});return fetcher(url,init);};
  f.ai.saveConnection({id:'openrouter',apiKey:'group-or-fixture-key'});f.ai.setEnabled({id:'openrouter',enabled:true});
  const title=f.ai.getPurposeProfiles().find(p=>p.purposeId==='listing_title')!;
  f.ai.savePurposeProfile({purposeId:title.purposeId,expectedRevision:title.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-astra',effort:'high'}});
  const result=await f.listing.suggest(f.reference);
  assert.equal(requests.filter(r=>r.fields.includes('item_name')).length,1);assert.equal(requests.find(r=>r.fields.includes('item_name'))!.model,'openai/gpt-6-astra');
  assert.equal(requests.find(r=>r.fields.includes('product_description'))!.model,'deepseek-flash');assert.ok(requests.length>=2);
  assert.ok(result.fieldGroupAssembly);assert.equal(result.fieldGroupAssembly!.sources.length,requests.length);
  assert.equal(result.output.kind,'amazon-fields');assert.ok((result.output as any).candidates.some((c:any)=>c.field==='item_name'));
  const count=f.requests.length,again=await f.listing.suggest(f.reference);assert.equal(again.id,result.id);assert.equal(f.requests.length,count);
  const file=join(f.directory,'groups.htcbackup');await createWorkspaceBackup(f.directory,file,'synthetic field group backup');const prepared=await prepareWorkspaceRestore(f.directory,file,'synthetic field group backup'),db=openDatabase(prepared.stagingDirectory);try{assertFieldGroupHistory(db);}finally{db.close();}
});
test('A43 completion invokes distinct missing-copy models and preserves manual values',async t=>{
  const f=await fixture(t);f.ai.saveConnection({id:'openrouter',apiKey:'completion-or-fixture-key'});f.ai.setEnabled({id:'openrouter',enabled:true});
  const persistence=(f.amazon as any).persistence,record=persistence.record(f.draft.id);delete record.draft.attributes.item_name;delete record.draft.attributes.product_description;persistence.putRecord(record);
  const p=f.ai.getPurposeProfiles().find(p=>p.purposeId==='listing_description')!;f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-astra',effort:'high'}});
  f.amazon.previewDraft=async()=>{const d=f.amazon.getDraft(f.draft.id),missing=['item_name','product_description'].filter(k=>!d.attributes[k]);return{...d,state:missing.length?'BLOCKED':'AMAZON_VALIDATED',previewIssues:missing.map(field=>({code:'MISSING',message:'Missing '+field,severity:'ERROR',category:'field',source:'amazon',attributeNames:[field],autoFixable:false}))};};
  const result=await f.listing.complete(f.reference);assert.deepEqual(result.remaining,[]);assert.equal(f.requests.length,3);assert.equal(result.aiCalls,3);
  assert.ok(result.draft.attributes.item_name);assert.ok(result.draft.attributes.product_description);
  assert.equal(f.ai.listCalls().filter(c=>c.model==='openai/gpt-6-astra').length,1);
});

test('A43 equal field configurations merge into one paid request while keeping every purpose snapshot',async t=>{
  const f=await fixture(t);const result=await f.listing.suggest(f.reference);assert.equal(f.requests.length,1);
  const call=f.ai.getCall(result.callId)!;assert.ok(call.purposeAssignments?.some(a=>a.field==='item_name'&&a.purpose.purposeId==='listing_title'));assert.ok(call.purposeAssignments?.some(a=>a.field==='product_description'&&a.purpose.purposeId==='listing_description'));
});
test('A43 partial grouped requests preserve completed work and never replay an unknown sibling',async t=>{
  const f=await fixture(t),transport=(f.ai as any).context,fetcher=transport.fetch;let posts=0;
  f.ai.saveConnection({id:'openrouter',apiKey:'partial-group-fixture-key'});f.ai.setEnabled({id:'openrouter',enabled:true});
  const p=f.ai.getPurposeProfiles().find(p=>p.purposeId==='listing_title')!;f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-astra',effort:'high'}});
  transport.fetch=async(url:any,init:any)=>{posts++;if(JSON.parse(init.body).model==='openai/gpt-6-astra')throw Error('lost response');return fetcher(url,init);};
  await assert.rejects(f.listing.suggest(f.reference));const original=f.ai.listResults(f.product.id);assert.equal(original.filter(r=>r.fieldGroupPart).length,1);assert.equal(posts,2);
  await assert.rejects(f.listing.suggest(f.reference),/原请求|重发/);assert.equal(posts,2);assert.deepEqual(f.ai.listResults(f.product.id),original);
});

test('A35 older backup retains grouped call identities and budgets without importing absent domain results',async t=>{
  const f=await fixture(t),file=join(f.directory,'before-groups.htcbackup');await createWorkspaceBackup(f.directory,file,'synthetic group rollback');
  f.ai.saveConnection({id:'openrouter',apiKey:'rollback-group-fixture-key'});f.ai.setEnabled({id:'openrouter',enabled:true});
  const p=f.ai.getPurposeProfiles().find(p=>p.purposeId==='listing_title')!;f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-astra',effort:'high'}});
  const result=await f.listing.suggest(f.reference),prepared=await prepareWorkspaceRestore(f.directory,file,'synthetic group rollback'),db=openDatabase(prepared.stagingDirectory);
  try{
    assertFieldGroupHistory(db);const group=JSON.parse(String(db.prepare('SELECT record_json FROM ai_field_groups WHERE id=?').get(result.fieldGroupAssembly!.operationId)!.record_json));
    assert.equal(group.resultId,null);assert.equal(group.members.every((m:any)=>m.sent&&m.resultId===null),true);assert.equal(db.prepare('SELECT count(*) n FROM ai_usage_ledger').get()!.n,group.members.length);
    assert.equal(db.prepare('SELECT count(*) n FROM ai_results').get()!.n,0);
  }finally{db.close();}
});
test('partial completion recovery cannot adopt its first child as the complete group',async t=>{
  const f=await fixture(t),transport=(f.ai as any).context,fetcher=transport.fetch;let posts=0;
  const persistence=(f.amazon as any).persistence,record=persistence.record(f.draft.id);delete record.draft.attributes.item_name;delete record.draft.attributes.product_description;persistence.putRecord(record);
  f.ai.saveConnection({id:'openrouter',apiKey:'completion-partial-fixture-key'});f.ai.setEnabled({id:'openrouter',enabled:true});
  const p=f.ai.getPurposeProfiles().find(p=>p.purposeId==='listing_description')!;f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-astra',effort:'high'}});
  f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:'BLOCKED',previewIssues:['item_name','product_description'].map(field=>({code:'MISSING',message:'Missing '+field,severity:'ERROR',category:'field',source:'amazon',attributeNames:[field],autoFixable:false}))});
  transport.fetch=async(url:any,init:any)=>{posts++;if(JSON.parse(init.body).model==='openai/gpt-6-astra')throw Error('lost second result');return fetcher(url,init);};
  await assert.rejects(f.listing.complete(f.reference));await assert.rejects(f.listing.complete(f.reference),/原请求|重发/);
  assert.equal(posts,2);assert.equal(f.amazon.getDraft(f.draft.id).fieldAdoptions?.length??0,0);assert.equal(f.listing.completionOperations(f.draft.id)[0].rounds[0].candidate.resultId,null);
});
test('a grouped paid response interrupted by Schema validation is parsed locally without another request',async t=>{
  const {SchemaTransientError}=await import('../src/main/amazon/schema-retry.ts');
  const f=await fixture(t);f.ai.saveConnection({id:'openrouter',apiKey:'group-recovery-fixture-key'});f.ai.setEnabled({id:'openrouter',enabled:true});
  const p=f.ai.getPurposeProfiles().find(p=>p.purposeId==='listing_title')!;f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-astra',effort:'high'}});
  const context=f.listing.currentContext(f.draft,f.product,f.amazon.executionTargetScope(f.draft.targetId).generation);let fail=true;
  const fresh=async()=>{if(fail&&f.requests.length)throw new SchemaTransientError('BODY_INCOMPLETE');};
  await assert.rejects(f.ai.listingFields(context,fresh));const original=f.ai.listCalls()[0];assert.equal(f.requests.length,1);assert.equal(original.schemaResponseRetained,true);fail=false;
  const result=await f.ai.listingFields(context,fresh);assert.equal(f.requests.length,2);assert.ok(result.fieldGroupAssembly?.sources[0].localRecovery);assert.deepEqual(f.ai.getCall(original.id),original);assert.equal(f.ai.getResult(result.id)?.id,result.id);
});
test('mixed completion keeps a missing title on its configured purpose while repairing an existing material',async t=>{
  const {fieldPurposeGroups}=await import('../src/main/ai/field-purpose-groups.ts');
  const f=await fixture(t),p=f.ai.getPurposeProfiles().find(p=>p.purposeId==='listing_title')!;
  f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-astra',effort:'high'}});
  const context=f.listing.currentContext(f.draft,f.product,f.amazon.executionTargetScope(f.draft.targetId).generation);context.fields=context.fields.filter(v=>['item_name','material'].includes(v.name));context.repairRequest={issues:[{field:'item_name',code:'MISSING',message:'Missing title'},{field:'material',code:'INVALID',message:'Fix material'}],currentValues:{item_name:null,material:[{value:'Wrong material'}]}};
  const db=openDatabase(f.directory);try{const assignments=fieldPurposeGroups(db,context,true).flatMap(g=>g.assignments);assert.equal(assignments.find(a=>a.field==='item_name')?.purpose.model,'openai/gpt-6-astra');assert.equal(assignments.find(a=>a.field==='material')?.purpose.purposeId,'listing_repair');}finally{db.close();}
});
for(const valid of [true,false])test(`cross-group dependentRequired jointly revalidates ${valid?'valid':'invalid'} siblings without an extra paid repair`,async t=>{
  const f=await fixture(t),persistence=(f.amazon as any).persistence,record=persistence.record(f.draft.id);delete record.draft.attributes.item_name;delete record.draft.attributes.material;
  record.draft.schema.schema.dependentRequired={item_name:['material']};record.draft.schema.checksum=createHash('md5').update(JSON.stringify(record.draft.schema.schema)).digest('base64');persistence.putRecord(record);f.amazon.getSchema=async()=>structuredClone(record.draft.schema);
  f.ai.saveConnection({id:'openrouter',apiKey:'dependent-group-fixture-key'});f.ai.setEnabled({id:'openrouter',enabled:true});
  const p=f.ai.getPurposeProfiles().find(p=>p.purposeId==='listing_title')!;f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-astra',effort:'high'}});
  if(!valid)f.respond(payload=>{const output=candidateFor(payload);const material=output.candidates.find((c:any)=>c.field==='material');if(material)(material as any).nativeValue=[{value:3}];return chat(output);});
  const result=await f.listing.suggest(f.reference);assert.equal(result.output.kind,'amazon-fields');const output=result.output as any;
  assert.equal(output.candidates.some((c:any)=>c.field==='item_name'),valid);assert.equal(output.candidates.some((c:any)=>c.field==='material'),valid);assert.equal(output.missing.some((m:any)=>m.field==='item_name'),!valid);assert.equal(f.requests.length,2);
});
for(const reference of ['invented-proof-id','00000000-0000-4000-a000-000000000001:spec'])test(`group composition cannot rehabilitate a rejected citation: ${reference}`,async t=>{
  const f=await fixture(t);f.ai.saveConnection({id:'openrouter',apiKey:'citation-group-fixture-key'});f.ai.setEnabled({id:'openrouter',enabled:true});
  const p=f.ai.getPurposeProfiles().find(p=>p.purposeId==='listing_title')!;f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-astra',effort:'high'}});
  f.respond(payload=>{const output=candidateFor(payload),material=output.candidates.find((c:any)=>c.field==='material');if(material)material.items[0].evidenceIds=[reference];return chat(output);});
  const result=await f.listing.suggest(f.reference),output=result.output as any;
  assert.equal(output.candidates.some((c:any)=>c.field==='material'),false);assert.ok(output.missing.some((m:any)=>m.field==='material'&&m.reason.includes('[FIELD_REFERENCE]')));
  assert.ok(result.fieldGroupAssembly?.sources.some(s=>s.output.kind==='amazon-fields'&&s.output.rejectedCandidates?.some(c=>c.field==='material')));
});
