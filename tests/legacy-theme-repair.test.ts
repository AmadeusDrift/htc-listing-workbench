import { completionOwnerFixture } from './fixtures/completion-owners.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, chat } from './fixtures/listing-ai.ts';
import { CompletionJournal, completionDraftStamp, completionSafetyIdentity, completionSafetyScope } from '../src/main/listing-ai/completion-journal.ts';
import { imageWorkflowDraftStamp } from '../src/main/image-workflow/records.ts';


const reason='仅推断候选可以携带推断理由；已保留其他合格字段';
async function setup(t:any){
 const f=await fixture(t,{theme:{type:'array',items:{type:'object',properties:{value:{type:'string'}},required:['value']}}});
 const context=f.listing.currentContext(f.draft,f.product,0,true);context.fields=context.fields.filter(x=>x.name==='theme');context.repairRequest={issues:[{field:'theme',code:'90220',message:'Missing theme'}],currentValues:{theme:null}};
 f.respond(()=>chat({kind:'amazon-fields',candidates:[],missing:[{field:'theme',reason}]}));
 const result=await f.ai.listingFields(context,async()=>{},undefined);
 const workflow:any={id:randomUUID(),draftId:f.draft.id,productId:f.draft.productId,productRevision:f.draft.productRevision,variantId:f.draft.variantId,sku:f.draft.sku,status:'COMPLETED',stage:'complete',approvedAssetId:randomUUID(),approvedSha256:'a'.repeat(64),slots:Array.from({length:7},()=>({status:'PASSED',approvedAssetId:randomUUID(),approvedSha256:'a'.repeat(64)}))};
 const row:any={draftId:f.draft.id,repairAttempts:4,repairPolicyMigration:{grantedAttempts:1},sourceColorRepair:{grantedAttempts:1},categoryFieldPolicyVersion:'category-inference/v1',imageStarted:true,repair:{phase:'FIELDS_PENDING',sourceWorkflowId:workflow.id,draftRevision:f.draft.revision,draftStamp:imageWorkflowDraftStamp(f.draft)}};
 const input={draftId:f.draft.id,scopeHash:'b'.repeat(64),safetyScopeHash:completionSafetyScope(f.draft),safetyIdentity:completionSafetyIdentity(f.draft),copyReviewEnabled:true,draftRevision:f.draft.revision,draftStamp:completionDraftStamp(f.draft)};
 const db=(f.ai as any).db;const journal=new CompletionJournal(db,f.directory);
 return {...f,context,result,workflow,row,input,db,journal,begin:()=>journal.beginLegacyThemeRepair(input,f.draft,context,row,workflow)};
}
test('legacy finite-parser loss creates exactly one scoped successor and preserves history',async t=>{
 const f=await setup(t),before=f.db.prepare('select record_json from ai_results').all();
 const op=f.begin();assert.ok(op);assert.deepEqual(op.scopedRepair?.fields,['theme']);assert.equal(op.scopedRepair?.sourceResultId,f.result.id);assert.equal(f.begin()?.id,op.id);assert.equal(f.journal.list(f.draft.id).length,1);assert.deepEqual(f.db.prepare('select record_json from ai_results').all(),before);assert.equal(f.row.repairAttempts,4);
});
for(const change of ['ordinary','similar','source','present','unknown','candidate','images'])test(`legacy repair refuses ${change}`,async t=>{
 const f=await setup(t);
 if(change==='ordinary')f.row.repairAttempts=2;
 if(change==='similar'){const result=structuredClone(f.result);(result.output as any).missing[0].reason=reason+'!';f.db.prepare('update ai_results set record_json=? where id=?').run(JSON.stringify(result),result.id);}
 if(change==='source')f.context.unverifiedSourceTitle+='changed';
 if(change==='present')f.draft.attributes.theme=[{value:'Existing'}];
 if(change==='unknown'){const call=f.ai.getCall(f.result.callId)!;call.status='RUNNING';call.finishedAt=null;f.db.prepare('update ai_calls set record_json=? where id=?').run(JSON.stringify(call),call.id);}
 if(change==='candidate'){
   const context=f.listing.currentContext(f.draft,f.product,0);
   f.respond(()=>chat({kind:'amazon-fields',contract:'listing-full-schema/v1',candidates:[{field:'theme',nativeValue:[{value:'Coaster'}],evidenceIds:[],transformation:'infer',inferenceReason:'Category inferred from the source product'}],missing:[]}));
   await f.ai.listingFields(context,async()=>{},undefined);
 }
 if(change==='images')f.workflow.slots.pop();
 assert.equal(f.begin(),undefined);assert.equal(f.journal.list(f.draft.id).length,0);
});



async function automaticLegacy(t:any,haul=false,priced=false){
 const f=await completionOwnerFixture(t,'automatic',false,false,'Blue',true,haul?'haul':'standard');
 if(priced){
   const p=(f.amazon as any).persistence,r=p.record(f.draft.id),measurement={type:'object',properties:{value:{type:'number'},unit:{enum:['inches']}},required:['value','unit']};
   Object.assign(r.draft.schema.schema.properties,{brand:{type:'array',items:{type:'object',properties:{value:{type:'string'}}}},item_package_dimensions:{type:'array',items:{type:'object',properties:{length:measurement,width:measurement,height:measurement},required:['length','width','height']}},item_package_weight:{type:'array',items:{type:'object',properties:{value:{type:'number'},unit:{enum:['pounds']}},required:['value','unit']}}});p.putRecord(r);
   f.amazon.getSchema=async()=>structuredClone(r.draft.schema);Object.assign(f.draft,f.amazon.applyBusinessDefaults({id:r.draft.id,revision:r.draft.revision}));
   const owner=f.ownerService() as any,task=[...owner.tasks.values()][0] as any;Object.assign(task.items[0].repair,{draftRevision:f.draft.revision,draftStamp:imageWorkflowDraftStamp(f.draft)});owner.save(task);
 }
 const context=f.listing.currentContext(f.draft,f.product,1,true);context.fields=context.fields.filter(x=>x.name==='theme');context.repairRequest={issues:[{field:'theme',code:'90220',message:'Missing theme'}],currentValues:{theme:null}};
 f.respond(()=>chat({kind:'amazon-fields',candidates:[],missing:[{field:'theme',reason}]}));await f.ai.listingFields(context,async()=>{},undefined);
 const service=f.ownerService() as any,task=[...service.tasks.values()][0] as any,row=task.items[0],at=new Date().toISOString();
 Object.assign(row,{repairAttempts:4,repairPolicyMigration:{version:'field-evidence/v2',previousAttempts:2,grantedAttempts:1,grantedAt:at,fields:['theme']},sourceColorEvidenceSha256:'c'.repeat(64),sourceColorRepair:{previousAttempts:3,grantedAttempts:1,grantedAt:at,evidenceSha256:'c'.repeat(64)}});service.save(task);
 const before=structuredClone(f.amazon.getDraft(f.draft.id));
 f.respond(()=>chat({kind:'amazon-fields',contract:'listing-full-schema/v1',candidates:[{field:'theme',nativeValue:[{value:'Nature'}],evidenceIds:[],transformation:'infer',inferenceReason:'A broad product theme from the source'},{field:'material',nativeValue:[{value:'Wood'}],evidenceIds:[],transformation:'infer'}],missing:[]}));
 return {...f,before};
}
test('automatic owner consumes one scoped grant before send; resume preserves old attempts/images/history and rechecks',async t=>{
 const f=await automaticLegacy(t),initialCalls=f.ai.listCalls().length,images=structuredClone((f.ownerService() as any).deps.images.getProgress(f.draft.id));
 let intercepted=false;const fields=f.ai.listingFields.bind(f.ai);
 f.ai.listingFields=async(...args)=>{const result=await fields(...args);if(!intercepted){intercepted=true;throw Error('after scoped result');}return result;};
 await assert.rejects(f.run(),/after scoped result/);
 const row=f.progress() as any;assert.equal(row.repairAttempts,5);assert.deepEqual(row.legacyThemeRepair.fields,['theme']);assert.equal(row.sourceColorRepair.previousAttempts,3);assert.equal(row.repairPolicyMigration.previousAttempts,2);
 const operation=f.listing.getCompletion(row.repair.operationId);assert.deepEqual(operation.rounds[0].context.fields.map(field=>field.name),['theme']);
 await f.reopen();await assert.rejects(f.run(),/Downstream image recheck sentinel/);
 assert.equal(f.ai.listCalls().length,initialCalls+1);assert.equal((f.progress() as any).repairAttempts,5);assert.equal((f.progress() as any).repair.phase,'RECHECK_PENDING');
 const draft=f.amazon.getDraft(f.draft.id);assert.deepEqual(draft.attributes.material,f.before.attributes.material);assert.equal((draft.attributes.theme as any)[0].value,'Nature');assert.deepEqual(draft.fieldAdoptions?.at(-1)?.fields,['theme']);
 assert.deepEqual((f.ownerService() as any).deps.images.getProgress(f.draft.id),images);
 await f.reopen();await assert.rejects(f.run(),/Downstream image recheck sentinel/);assert.equal(f.ai.listCalls().length,initialCalls+1);
});
test('successor created before owner checkpoint resumes once, with no duplicate grant',async t=>{
 const f=await automaticLegacy(t),service=f.ownerService() as any,begin=service.deps.beginLegacyThemeRepair;let stopped=false;
 service.deps.beginLegacyThemeRepair=(...args:any[])=>{const id=begin(...args);if(!stopped){stopped=true;throw Error('before owner checkpoint');}return id;};
 await assert.rejects(f.run(),/before owner checkpoint/);assert.equal((f.progress() as any).repairAttempts,4);const id=f.listing.completionOperations(f.draft.id)[0].id;
 await f.reopen();await assert.rejects(f.run(),/Downstream image recheck sentinel/);assert.equal(f.listing.completionOperations(f.draft.id).length,1);assert.equal((f.progress() as any).legacyThemeRepair.operationId,id);assert.equal((f.progress() as any).repairAttempts,5);
});
test('scoped operation retains its theme scope in both rounds and cannot adopt unrelated output',async t=>{
 const f=await automaticLegacy(t);let count=0;
 f.respond(()=>chat(++count===1?{kind:'amazon-fields',contract:'listing-full-schema/v1',candidates:[],missing:[{field:'theme',reason:'[FIELD_REFERENCE] Missing initial observation'}]}:{kind:'amazon-fields',contract:'listing-full-schema/v1',candidates:[{field:'theme',nativeValue:[{value:'Nature'}],evidenceIds:[],transformation:'infer'},{field:'material',nativeValue:[{value:'Wood'}],evidenceIds:[],transformation:'infer'}],missing:[]}));
 await assert.rejects(f.run(),/Downstream image recheck sentinel/);const op=f.listing.completionOperations(f.draft.id)[0];assert.equal(op.rounds.length,2);assert.ok(op.rounds.every(r=>r.context.fields.length===1&&r.context.fields[0].name==='theme'));assert.deepEqual(f.amazon.getDraft(f.draft.id).attributes.material,f.before.attributes.material);
 const resultId=op.rounds[1].candidate.resultId!;await assert.rejects(f.listing.adopt({draftId:f.draft.id,draftRevision:f.amazon.getDraft(f.draft.id).revision,suggestionResultId:resultId,reviewResultId:null,fields:['material']}),/仅允许采纳 theme/);
});
test('scoped exhaustion preserves five attempts and cannot create a third round or another grant',async t=>{
 const f=await automaticLegacy(t);f.respond(()=>chat({kind:'amazon-fields',contract:'listing-full-schema/v1',candidates:[],missing:[{field:'theme',reason:'[FIELD_REFERENCE] Still missing'}]}));
 await assert.rejects(f.run());const calls=f.ai.listCalls().length;assert.equal((f.progress() as any).repairAttempts,5);assert.equal(f.listing.completionOperations(f.draft.id)[0].rounds.length,2);
 await f.reopen();await assert.rejects(f.run());assert.equal(f.ai.listCalls().length,calls);assert.equal(f.listing.completionOperations(f.draft.id).length,1);
});
import { parseFullGeneration } from '../src/main/listing-ai/full-schema.ts';
import { listingFingerprint } from '../src/main/listing-ai/validation.ts';
test('modern full-schema parser retains a non-infer explanatory theme candidate',async t=>{
 const f=await setup(t),context=f.listing.currentContext(f.draft,f.product,0);
 const output=parseFullGeneration({kind:'amazon-fields',candidates:[{field:'theme',nativeValue:[{value:'Coaster'}],evidenceIds:[],transformation:'copy',inferenceReason:'Explanatory annotation retained'}],missing:[]},context);
 assert.equal(output.candidates[0].items[0].inferenceReason,'Explanatory annotation retained');assert.deepEqual(output.missing,[]);
});
test('scoped journal refuses a send without the persisted consumed owner grant',async t=>{
 const f=await setup(t),op=f.begin()!,id=randomUUID();op.rounds.push({context:f.context,contextHash:listingFingerprint(f.context),candidate:{id,sent:false,resultId:null},review:{id:randomUUID(),sent:false,resultId:null},resolved:false,adoptionId:null});f.journal.save(op);
 const call={...f.ai.getCall(f.result.callId)!,id};
 assert.throws(()=>f.journal.markSent({operationId:op.id,callId:id,contextHash:listingFingerprint(f.context)},call),/额度尚未持久化/);assert.equal(f.journal.get(op.id).rounds[0].candidate.sent,false);
});
for(const dirty of ['color','unsupported'] as const)test(`eligible legacy ${dirty} normalization fails closed before preview or paid dispatch`,async t=>{
 const f=await automaticLegacy(t,true),db=(f.ai as any).db,record=JSON.parse(db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(f.draft.id).record_json);
 if(dirty==='color')record.draft.attributes.color=[{value:'Cherry Blossom Pink',marketplace_id:f.draft.marketplaceId}];
 else record.draft.attributes.fulfillment_availability=[{fulfillment_channel_code:'DEFAULT',quantity:20}];
 record.request.attributes=structuredClone(record.draft.attributes);db.prepare('UPDATE listing_drafts SET record_json=? WHERE id=?').run(JSON.stringify(record),f.draft.id);
 const service=f.ownerService() as any,task=[...service.tasks.values()][0] as any;task.items[0].repair.draftStamp=imageWorkflowDraftStamp(record.draft);service.save(task);
 assert.deepEqual(f.amazon.getDraft(f.draft.id).attributes,record.draft.attributes);assert.equal(f.amazon.getDraft(f.draft.id).listingProgram,'haul');
 const before=db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(f.draft.id).record_json,calls=f.ai.listCalls().length;
 assert.throws(()=>f.listing.beginLegacyThemeRepair(f.draft.id,task.items[0],service.deps.images.getProgress(f.draft.id)),/theme 定向修复不能规范化其他字段/);
 assert.equal(db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(f.draft.id).record_json,before);assert.equal(f.ai.listCalls().length,calls);assert.equal(f.previews(),0);assert.equal((f.progress() as any).repairAttempts,4);
});

for(const boundary of ['preview','adoption'] as const)for(const dirty of ['color','unsupported'] as const)test(`scoped ${boundary} rejects ${dirty} normalization without an attribute or event write`,async t=>{
 const f=await automaticLegacy(t,true),service=f.ownerService() as any,task=[...service.tasks.values()][0] as any;
 const op=f.listing.beginLegacyThemeRepair(f.draft.id,task.items[0],service.deps.images.getProgress(f.draft.id))!;assert.ok(op);
 const db=(f.ai as any).db,record=JSON.parse(db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(f.draft.id).record_json);
 if(dirty==='color')record.draft.attributes.color=[{value:'Cherry Blossom Pink',marketplace_id:f.draft.marketplaceId}];
 else record.draft.attributes.fulfillment_availability=[{fulfillment_channel_code:'DEFAULT',quantity:20}];
 record.request.attributes=structuredClone(record.draft.attributes);db.prepare('UPDATE listing_drafts SET record_json=? WHERE id=?').run(JSON.stringify(record),f.draft.id);
 const source=f.ai.listResults(f.product.id).find(result=>result.output.kind==='amazon-fields')!;
 op.draftStamp=completionDraftStamp(record.draft);op.rounds=[{context:source.listingContext!,contextHash:source.sourceSha256!,candidate:{id:source.callId,sent:true,resultId:source.id},review:null,resolved:false,adoptionId:null}];f.ai.completionJournal.save(op);
 const before=db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(f.draft.id).record_json,events=JSON.stringify(db.prepare('SELECT * FROM audit_events').all()),calls=f.ai.listCalls().length;
 if(boundary==='preview')await assert.rejects(f.amazon.previewDraft({id:f.draft.id,revision:record.draft.revision},op.id),/theme 定向修复不能规范化其他字段/);
 else {
   const after={...record.draft.attributes,theme:[{value:'Nature'}]},adoption:any={id:'d'.repeat(64),at:new Date().toISOString(),suggestionResultId:source.id,reviewResultId:null,contextSha256:source.sourceSha256,fromRevision:record.draft.revision,toRevision:record.draft.revision+1,fields:['theme'],changes:[{field:'theme',before:null,after:after.theme,evidence:[]}],reviewDisposition:'SKIPPED_DISABLED'};
   assert.throws(()=>f.amazon.adoptFields({id:f.draft.id,revision:record.draft.revision},after,adoption,()=>{}),/theme 定向修复不能规范化其他字段/);
 }
 assert.equal(db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(f.draft.id).record_json,before);assert.equal(JSON.stringify(db.prepare('SELECT * FROM audit_events').all()),events);assert.equal(f.ai.listCalls().length,calls);assert.equal(f.previews(),0);
});

async function completedOldBrand(t:any){
 const f=await automaticLegacy(t,true,true);await assert.rejects(f.run(),/Downstream image recheck sentinel/);
 const service=f.ownerService() as any,p=(f.amazon as any).persistence,record=p.record(f.draft.id),task=[...service.tasks.values()][0] as any,row=task.items[0];
 record.draft.schema.schema.properties.brand={type:'array',items:{type:'object',properties:{value:{type:'string'}}}};
 record.draft.attributes.brand=[{value:'其他'}];delete record.draft.businessRules.fields.brand;
 const issue={code:'5665',source:'amazon',severity:'ERROR',category:'field',attributeNames:['brand'],autoFixable:false,message:'Old brand approval'};
 record.draft.previewIssues=[issue];record.previewResponse={issues:[issue]};record.exchanges=[{id:randomUUID(),at:new Date().toISOString(),operation:'preview',revision:record.draft.revision,request:{attributes:{brand:record.draft.attributes.brand}},response:{issues:[issue]},status:200,requestId:null,schemaChecksum:record.draft.schema.checksum,schemaVersion:record.draft.schema.version}];p.putRecord(record);
 const op=f.listing.getCompletion(row.repair.operationId);op.safetyIdentity=completionSafetyIdentity(record.draft);op.safetyScopeHash=completionSafetyScope(record.draft);op.draftStamp=completionDraftStamp(record.draft);op.scopeHash=(f.listing as any).completionScope(record.draft);f.ai.completionJournal.save(op);
 row.repair={...row.repair,phase:'FIELDS_PENDING',remaining:['brand：Old brand approval'],draftRevision:record.draft.revision,draftStamp:imageWorkflowDraftStamp(record.draft)};service.save(task);
 return {f,service,p,record,task,row,op};
}

test('completed scoped theme migrates old brand atomically with owner and resumes recheck at five attempts',async t=>{
 const {f,p,record,task,op}=await completedOldBrand(t);
 const before={draft:p.db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(f.draft.id).record_json,op:f.listing.getCompletion(op.id),task:JSON.parse(p.db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(task.id).record_json)};
 p.db.exec("CREATE TRIGGER abort_brand_audit BEFORE INSERT ON audit_events WHEN NEW.action='listing.fixed-brand-migrated' BEGIN SELECT RAISE(ABORT,'injected migration interruption'); END");
 assert.throws(()=>f.amazon.migrateFixedBrand({id:record.draft.id,revision:record.draft.revision},op.id),/injected migration interruption/);
 assert.equal(p.db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(f.draft.id).record_json,before.draft);assert.deepEqual(f.listing.getCompletion(op.id),before.op);assert.deepEqual(JSON.parse(p.db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(task.id).record_json),before.task);
 p.db.exec('DROP TRIGGER abort_brand_audit');const calls=f.requests.length;
 const migrate=f.amazon.migrateFixedBrand.bind(f.amazon);let interrupted=false;f.amazon.migrateFixedBrand=(...args)=>{const draft=migrate(...args);if(!interrupted){interrupted=true;throw Error('after migration commit');}return draft;};
 await assert.rejects(f.run(),/after migration commit/);
 await f.reopen();await assert.rejects(f.run(),/Downstream image recheck sentinel/);
 assert.equal((f.amazon.getDraft(f.draft.id).attributes.brand as any)[0].value,'Generic');assert.equal((f.progress() as any).repairAttempts,5);assert.equal((f.progress() as any).repair.phase,'RECHECK_PENDING');assert.equal(f.requests.length,calls);
 const after=f.listing.getCompletion(op.id);assert.deepEqual(after.rounds,before.op.rounds);assert.deepEqual(after.scopedRepair,before.op.scopedRepair);
 const revision=f.amazon.getDraft(f.draft.id).revision;await f.reopen();await assert.rejects(f.run(),/Downstream image recheck sentinel/);assert.equal(f.amazon.getDraft(f.draft.id).revision,revision);assert.equal(f.requests.length,calls);
});

for(const stop of [null,'PAUSED','CANCELLED'] as const)test(`pump preserves row identities and sibling checkpoint after brand commit interruption (${stop??'continue'})`,async t=>{
 const {f,service,p,task,row}=await completedOldBrand(t);
 const sibling=structuredClone(row);sibling.variantId=randomUUID();delete sibling.salesPlan;sibling.key=sibling.productId+':'+sibling.variantId;sibling.sku='SIBLING';sibling.draftId=null;sibling.repair=null;sibling.executionTaskIds=[];sibling.repairAttempts=0;delete sibling.legacyThemeRepair;delete sibling.sourceColorRepair;delete sibling.sourceColorEvidenceSha256;delete sibling.repairPolicyMigration;
 row.status='PENDING';sibling.status='PENDING';task.items.push(sibling);task.status='QUEUED';service.save(task);
 const items=task.items,calls=f.requests.length,childId=randomUUID();let visits=0;
 const migrate=f.amazon.migrateFixedBrand.bind(f.amazon);f.amazon.migrateFixedBrand=(...args)=>{
   migrate(...args);const saved=JSON.parse(p.db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(task.id).record_json);
   saved.items[1].executionTaskIds=[childId];saved.items[1].imageAttempts=2;saved.items[1].error='Unknown request retained';
   if(stop)saved.status=stop;saved.revision++;p.db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(saved),task.id);throw Error('after migration commit');
 };
 // Run the real pump/outer catch; isolate unrelated later preparation and connections.
 service.prepareItem=async(current:any,item:any)=>{if(item.key===row.key)return service.finishRepair(current,item);visits++;assert.equal(item,sibling);assert.deepEqual(item.executionTaskIds,[childId]);assert.equal(item.imageAttempts,2);assert.equal(item.error,'Unknown request retained');item.status='FAILED';item.error='sibling checkpoint retained';service.save(current);};
 service.assertConnections=()=>{};service.refreshWaiting=async()=>{};service.grants.add(task.id);service.pump();await service.worker;
 assert.equal(task.items,items);assert.equal(task.items[0],row);assert.equal(task.items[1],sibling);
 const saved=JSON.parse(p.db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(task.id).record_json);
 assert.equal(saved.items[0].repairAttempts,5);assert.equal(saved.items[0].repair.draftRevision,f.amazon.getDraft(f.draft.id).revision);assert.deepEqual(saved.items[1].executionTaskIds,[childId]);assert.equal(saved.items[1].imageAttempts,2);
 if(stop){assert.equal(saved.status,stop);assert.equal(visits,0);}else{assert.equal(saved.items[0].status,'FAILED');assert.ok(saved.items[0].error);assert.equal(saved.items[0].outcome.kind,'SYSTEM_REPAIR');assert.equal(saved.items[1].status,'FAILED');assert.equal(visits,1);}
 assert.equal(f.requests.length,calls);
});
