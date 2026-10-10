import {ImageWorkflowService} from '../src/main/image-workflow/service.ts';
import {PRODUCT_IMAGE_POLICY_VERSION} from '../src/shared/image-ai-contracts.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {suggestListingFields} from '../src/main/ai/listing-adapters.ts';
import {validateAiCall} from '../src/main/ai/validation.ts';
import {chat} from './fixtures/listing-ai.ts';

test('trusted partial repair separates local rejection and model missing without altering output',async()=>{
 const c:any={variantId:randomUUID(),fields:['item_name','bullet_point','fabric_type'].map(name=>({name,closedEnum:false,allowedValues:[]})),evidence:[{id:'material',name:'材质',value:'树脂',meaning:'material',source:'source_confirmed'}],repairRequest:{issues:[],currentValues:{}}};
 const raw={kind:'amazon-fields',candidates:[{field:'item_name',items:[{value:'中文',evidenceIds:['material'],transformation:'translate'}]},{field:'fabric_type',items:[{value:'Not Applicable',evidenceIds:['material'],transformation:'translate'}]}],missing:[{field:'bullet_point',reason:'https://secret.invalid/?token=secret EMPTY_PROMPT'}]};
 const result:any=await suggestListingFields(c,'deepseek-flash',{apiKey:'test-only'},new AbortController().signal,{now:()=>new Date(),nonce:randomUUID,maxResponseBytes:200000,fetch:async()=>chat(raw)});
 assert.deepEqual(result.fieldRejections,{version:'rejection-presentation/v1',entries:[{field:'bullet_point',origin:'model-missing',code:'FIELD_CANDIDATE_ABSENT'},{field:'item_name',origin:'local-validation',code:'FIELD_FORMAT_INVALID'}]});
 assert.equal(result.output.candidates[0].items[0].value,'Not Applicable');
 assert.equal(result.output.missing[0].reason,raw.missing[0].reason);
 assert.doesNotMatch(JSON.stringify(result.fieldRejections),/secret|https/);
});

test('AiCall preserves strict fixed output reason and rejects unrelated statuses or injected metadata',()=>{
 const call:any={id:randomUUID(),providerId:'deepseek',productId:randomUUID(),productRevision:1,status:'FAILED',errorCode:'OUTPUT_INVALID',requestId:null,model:'deepseek-flash',generation:1,startedAt:'2026-10-11T00:00:00.000Z',finishedAt:'2026-10-11T00:00:01.000Z',usage:{promptTokens:0,completionTokens:0,processedImages:0},rejection:{version:'rejection-presentation/v1',code:'EMPTY_PROMPT'}};
 assert.deepEqual((validateAiCall(call) as any).rejection,call.rejection);
 assert.throws(()=>validateAiCall({...call,rejection:{...call.rejection,prompt:'secret'}}));
 assert.throws(()=>validateAiCall({...call,rejection:{...call.rejection,code:'provider-secret'}}));
 assert.throws(()=>validateAiCall({...call,status:'SUCCEEDED',errorCode:null}));
 const {rejection,...legacy}=call;assert.deepEqual(validateAiCall(legacy),legacy);
});
import {AiError} from '../src/main/ai/errors.ts';
import {publicError} from '../src/main/security.ts';
import {presentRejection} from '../src/shared/rejection-presentation.ts';

test('fixed presentation distinguishes trusted image failures and unknown always wins',()=>{
 assert.notEqual(publicError(new AiError('OUTPUT_INVALID','EMPTY_PROMPT')),publicError(new AiError('OUTPUT_INVALID','UNSUPPORTED_MEASUREMENT')));
 assert.match(presentRejection('EMPTY_PROMPT',true),/结果未知/);
 assert.match(presentRejection('https://secret.invalid'),/无法归因/);
});

test('strict suggestion failure retains trusted local reason for safe public display',async()=>{
 const c:any={variantId:randomUUID(),fields:[{name:'item_name',closedEnum:false,allowedValues:[]}],evidence:[]};
 await assert.rejects(suggestListingFields(c,'deepseek-flash',{apiKey:'test-only'},new AbortController().signal,{now:()=>new Date(),nonce:randomUUID,maxResponseBytes:200000,fetch:async()=>chat({kind:'amazon-fields',candidates:[{field:'item_name',items:[{value:'中文',evidenceIds:['x'],transformation:'translate'}]}],missing:[]})}),error=>{assert.match(publicError(error),/格式、语言/);return true;});
});
import {readFileSync} from 'node:fs';
import {validateImageWorkflowRun} from '../src/main/image-workflow/records.ts';

test('workflow keeps an exact call and stage reference even before slot attempts exist',()=>{
 const saved=JSON.parse(readFileSync(new URL('./fixtures/image-plan-rejections.json',import.meta.url),'utf8')).cases.find((c:any)=>c.workflow);
 const raw={...saved.workflow,rejection:{version:'rejection-presentation/v1',code:'EMPTY_PROMPT',callId:randomUUID(),resultId:null,contextSha256:'a'.repeat(64),stage:'planning',slot:0}};
 assert.deepEqual((validateImageWorkflowRun(raw) as any).rejection,raw.rejection);
 assert.throws(()=>validateImageWorkflowRun({...raw,rejection:{...raw.rejection,stage:'provider-secret'}}));
});

import {fixture, candidateFor, mockStorage} from './fixtures/listing-ai.ts';
import {AiService} from '../src/main/ai/service.ts';
import {openDatabase} from '../src/main/database.ts';
import {workflowRuns} from '../src/main/image-workflow/records.ts';
import {createWorkspaceBackup,prepareWorkspaceRestore,commitWorkspaceRestore} from '../src/main/backup.ts';
import {join} from 'node:path';
import {listingFingerprint} from '../src/main/listing-ai/validation.ts';
import {buildListingContext} from '../src/main/listing-ai/context.ts';

test('real AI failure persists fixed reason through restart and exact workflow ownership and backup without another request',async t=>{
 t.mock.method(globalThis,'fetch',()=>{throw Error('Network forbidden');});
 const f=await fixture(t);f.respond(payload=>{const output=candidateFor(payload);output.candidates[0].items[0].value='中文';return chat(output);});
 const operation=f.listing.beginCompletion(f.reference),context=f.listing.currentContext(f.draft,f.product,1),contextHash=listingFingerprint(context),candidateId=randomUUID();
 operation.rounds.push({context,contextHash,candidate:{id:candidateId,sent:false,resultId:null},review:operation.copyReviewEnabled?{id:randomUUID(),sent:false,resultId:null}:null,resolved:false,adoptionId:null});f.ai.completionJournal.save(operation);
 let caught:any;try{await f.ai.listingFields(context,async()=>{},undefined,undefined,{operationId:operation.id,callId:candidateId,contextHash});}catch(e){caught=e;}
 assert.ok(caught instanceof AiError);const call=f.ai.getCall(caught.callId!)!;
 assert.equal(call.rejection?.code,'FIELD_FORMAT_INVALID');assert.equal(call.presentationContext?.draftId,f.draft.id);assert.equal(f.requests.length,1);
 const p=call.presentationContext!,at=new Date().toISOString();
 const run:any={id:randomUUID(),draftId:f.draft.id,productId:f.product.id,productRevision:f.product.revision,variantId:f.draft.variantId,sku:f.draft.sku,status:'FAILED',stage:'content',attempt:0,maxAttempts:2,contextSha256:null,draftSha256:null,referenceAssets:[],planResultIds:[],candidateIds:[],ocrResultIds:[],reviewResultIds:[],approvedAssetId:null,approvedSha256:null,createdAt:at,updatedAt:at,error:'old local message',imagePolicyVersion:PRODUCT_IMAGE_POLICY_VERSION,slotPolicy:'seven-product-v2',ipReviewResultIds:[],slots:Array.from({length:7},(_,i)=>({index:i+1,purpose:i===0?'main':'detail',status:'PENDING',contextSha256:null,attempts:[],approvedAssetId:null,approvedSha256:null,error:null})),contentPreparation:{operationId:operation.id,state:'STARTED',draftRevision:f.draft.revision,remaining:[]},rejection:{...call.rejection,callId:call.id,resultId:null,contextSha256:p.sourceSha256,stage:'content',slot:0}};
 const db=openDatabase(f.directory);db.prepare('INSERT INTO image_workflow_runs VALUES(?,?)').run(run.id,JSON.stringify(run));
 assert.deepEqual(workflowRuns(db)[0].rejection,run.rejection);
 const progress=new ImageWorkflowService(f.directory,f.store,f.amazon,f.ai,{} as any);
 try{
  const rawBefore=String(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(run.id)!.record_json),journalBefore=JSON.stringify(f.ai.completionJournal.get(operation.id));
  assert.equal((progress.getProgressPresentation(run.draftId) as any)?.resultUnknown,true,'real sent/no-result journal must override local FIELD_FORMAT_INVALID');
  assert.equal(String(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(run.id)!.record_json),rawBefore);assert.equal(JSON.stringify(f.ai.completionJournal.get(operation.id)),journalBefore);
 }finally{await progress.close();}

 const rawCall=String(db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(call.id)!.record_json);
 await f.ai.close();let posts=0;const restarted=new AiService(f.directory,f.store,f.hosting,mockStorage,{fetch:async()=>{posts++;throw Error('No resend');}});
 try{assert.deepEqual(restarted.getCall(call.id),call);assert.equal(posts,0);}finally{await restarted.close();}
 const file=join(f.directory,'safe.htcbackup'),target=join(f.directory,'restore');await createWorkspaceBackup(f.directory,file,'synthetic-safe-passphrase');await commitWorkspaceRestore(target,await prepareWorkspaceRestore(target,file,'synthetic-safe-passphrase'));
 const restored=openDatabase(target);assert.equal(String(restored.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(call.id)!.record_json),rawCall);assert.deepEqual(workflowRuns(restored)[0].rejection,run.rejection);restored.close();
 for(const patch of [{draftId:randomUUID()},{variantId:randomUUID()},{sourceSha256:'b'.repeat(64)}]){
  db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify({...call,presentationContext:{...p,...patch}}),call.id);
  assert.throws(()=>workflowRuns(db));await assert.rejects(createWorkspaceBackup(f.directory,join(f.directory,'wrong.htcbackup'),'synthetic-safe-passphrase'));
 }
 db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(rawCall,call.id);
 const rawOperation=String(db.prepare('SELECT record_json FROM listing_completion_operations WHERE id=?').get(operation.id)!.record_json),wrongOperation=JSON.parse(rawOperation);wrongOperation.rounds[0].candidate.id=randomUUID();
 db.prepare('UPDATE listing_completion_operations SET record_json=? WHERE id=?').run(JSON.stringify(wrongOperation),operation.id);
 assert.throws(()=>workflowRuns(db),'content cause must name the actual sent journal call');await assert.rejects(createWorkspaceBackup(f.directory,join(f.directory,'wrong-journal.htcbackup'),'synthetic-safe-passphrase'));
 db.prepare('UPDATE listing_completion_operations SET record_json=? WHERE id=?').run(rawOperation,operation.id);db.close();assert.equal(f.requests.length,1);
});

test('real partial AI result persists local and model provenance, verifies owner, and preserves raw model output on restore',async t=>{
 t.mock.method(globalThis,'fetch',()=>{throw Error('Network forbidden');});const f=await fixture(t);
 const context=buildListingContext(f.draft,f.product,1);context.repairRequest={issues:[],currentValues:{}};
 f.respond(payload=>{const output=candidateFor(payload);output.candidates[0].items[0].value='中文';const omitted=output.candidates.pop()!;output.missing.push({field:omitted.field,reason:'missing'});for(const m of output.missing)m.reason='https://untrusted.invalid/?token=secret';return chat(output);});
 const result=await f.ai.listingFields(context,async()=>{});assert.ok(result.fieldRejections?.entries.some(e=>e.origin==='local-validation'));assert.ok(result.fieldRejections?.entries.some(e=>e.origin==='model-missing'));
 assert.deepEqual(f.ai.getResult(result.id),result);const db=openDatabase(f.directory),raw=String(db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(result.id)!.record_json),call=f.ai.getCall(result.callId)!;
 const file=join(f.directory,'fields.htcbackup'),target=join(f.directory,'restored');await createWorkspaceBackup(f.directory,file,'synthetic-fields-passphrase');await commitWorkspaceRestore(target,await prepareWorkspaceRestore(target,file,'synthetic-fields-passphrase'));
 const restored=openDatabase(target);assert.equal(String(restored.prepare('SELECT record_json FROM ai_results WHERE id=?').get(result.id)!.record_json),raw);restored.close();
 db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify({...call,presentationContext:{...call.presentationContext,variantId:randomUUID()}}),call.id);
 assert.throws(()=>f.ai.getResult(result.id));await assert.rejects(createWorkspaceBackup(f.directory,join(f.directory,'wrong-fields.htcbackup'),'synthetic-fields-passphrase'));db.close();assert.equal(f.requests.length,1);
});

import {automaticQueueReason} from '../src/renderer/automatic-product-groups.ts';
import {assertWorkflowRejectionOwner} from '../src/main/image-workflow/rejection.ts';
test('queue preserves fixed completion, readback, reconsideration and continuation guidance without raw messages',()=>{
 for(const [row,pattern] of [
  [{kind:'COMPLETED'},/流程已完成/],[{kind:'SUBMITTED'},/等待平台回读/],
  [{kind:'PENDING',noticeCode:'SOURCE_CHANGED'},/来源资料已变化，重新评估/],
  [{kind:'SYSTEM_REPAIR',noticeCode:'UNKNOWN_RECONCILED'},/原未知结果已核对/],
  [{kind:'SYSTEM_REPAIR',noticeCode:'EVIDENCE_READ_FAILED'},/暂无法核对已保存证据/],
  [{kind:'SYSTEM_REPAIR',reasonCode:'EMPTY_PROMPT',continuationRequired:true},/请继续或取消原任务/]
 ] as const){const text=automaticQueueReason({...row,message:'https://secret.invalid'} as any);assert.match(text,pattern);assert.doesNotMatch(text,/secret.invalid|历史记录/);}
 assert.match(automaticQueueReason({kind:'UNKNOWN',noticeCode:'UNKNOWN_RECONCILED',reasonCode:'EMPTY_PROMPT',message:''} as any),/结果未知/);
});
test('failed planning reason rejects a same-owner call from a different frozen context',()=>{
 const id=()=>randomUUID(),draftId=id(),variantId=id(),productId=id(),callId=id(),now='2026-10-11T00:00:00.000Z';
 const call=validateAiCall({id:callId,providerId:'deepseek',productId,productRevision:1,status:'FAILED',errorCode:'OUTPUT_INVALID',requestId:null,model:'deepseek-flash',generation:1,startedAt:now,finishedAt:now,usage:{promptTokens:0,completionTokens:0,processedImages:0},presentationContext:{kind:'image',draftId,variantId,sourceSha256:'b'.repeat(64),slot:0},rejection:{version:'rejection-presentation/v1',code:'EMPTY_PROMPT'}});
 const run=validateImageWorkflowRun({id:id(),draftId,productId,productRevision:1,variantId,sku:'synthetic',status:'FAILED',stage:'planning',attempt:0,maxAttempts:2,contextSha256:'a'.repeat(64),draftSha256:null,referenceAssets:[],planResultIds:[],candidateIds:[],ocrResultIds:[],reviewResultIds:[],approvedAssetId:null,approvedSha256:null,createdAt:now,updatedAt:now,error:'synthetic',rejection:{...call.rejection,callId,resultId:null,contextSha256:'b'.repeat(64),stage:'planning',slot:0}});
 assert.throws(()=>assertWorkflowRejectionOwner(run,()=>call,()=>undefined));
 assert.throws(()=>assertWorkflowRejectionOwner({...run,draftId:id()},()=>call,()=>undefined));
 const bound={...call,presentationContext:{...call.presentationContext!,workflowId:run.id}};
 assert.throws(()=>assertWorkflowRejectionOwner(run,()=>bound,()=>undefined),'workflow ID alone cannot override frozen context');
 const matching={...run,contextSha256:'b'.repeat(64)};
 assert.doesNotThrow(()=>assertWorkflowRejectionOwner(matching,()=>bound,()=>undefined));
 assert.throws(()=>assertWorkflowRejectionOwner({...matching,id:id()},()=>bound,()=>undefined),'same-context call cannot move to another workflow');
 assert.throws(()=>assertWorkflowRejectionOwner({...matching,rejection:{...matching.rejection!,slot:1}},()=>({...bound,presentationContext:{...bound.presentationContext,slot:1}}),()=>undefined),'missing frozen slot is not inferred from current state');
});

test('progress projection distinguishes unsent STARTED and completed journal without mutating stored workflow',async t=>{
 t.mock.method(globalThis,'fetch',()=>{throw Error('Network forbidden');});const f=await fixture(t),operation=f.listing.beginCompletion(f.reference),context=f.listing.currentContext(f.draft,f.product,1),contextHash=listingFingerprint(context),callId=randomUUID();
 operation.rounds.push({context,contextHash,candidate:{id:callId,sent:false,resultId:null},review:operation.copyReviewEnabled?{id:randomUUID(),sent:false,resultId:null}:null,resolved:false,adoptionId:null});f.ai.completionJournal.save(operation);
 const now=new Date().toISOString(),run:any={id:randomUUID(),draftId:f.draft.id,productId:f.product.id,productRevision:f.product.revision,variantId:f.draft.variantId,sku:f.draft.sku,status:'FAILED',stage:'content',attempt:0,maxAttempts:2,contextSha256:null,draftSha256:null,referenceAssets:[],planResultIds:[],candidateIds:[],ocrResultIds:[],reviewResultIds:[],ipReviewResultIds:[],approvedAssetId:null,approvedSha256:null,createdAt:now,updatedAt:now,error:null,imagePolicyVersion:PRODUCT_IMAGE_POLICY_VERSION,slotPolicy:'seven-product-v2',slots:Array.from({length:7},(_,i)=>({index:i+1,purpose:i===0?'main':'detail',status:'PENDING',contextSha256:null,attempts:[],approvedAssetId:null,approvedSha256:null,error:null})),contentPreparation:{operationId:operation.id,state:'STARTED',draftRevision:f.draft.revision,remaining:[]}};
 const db=openDatabase(f.directory),raw=JSON.stringify(run);db.prepare('INSERT INTO image_workflow_runs VALUES(?,?)').run(run.id,raw);
 const progress=new ImageWorkflowService(f.directory,f.store,f.amazon,f.ai,{} as any);
 try{
  assert.equal(progress.getProgressPresentation(run.draftId)?.resultUnknown,false);assert.equal(f.requests.length,0);
  await f.ai.listingFields(context,async()=>{},undefined,undefined,{operationId:operation.id,callId,contextHash});
  const done=f.ai.completionJournal.get(operation.id);done.state='DONE';f.ai.completionJournal.save(done);const journalBefore=JSON.stringify(f.ai.completionJournal.get(operation.id));
  assert.equal(progress.getProgressPresentation(run.draftId)?.resultUnknown,false);assert.equal(f.requests.length,1);
  assert.equal(JSON.stringify(f.ai.completionJournal.get(operation.id)),journalBefore);assert.equal(String(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(run.id)!.record_json),raw);assert.equal(Object.hasOwn(progress.getProgress(run.draftId)!,'resultUnknown'),false);
  db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(JSON.stringify({...run,variantId:randomUUID()}),run.id);assert.throws(()=>progress.getProgressPresentation(run.draftId));
  db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(JSON.stringify({...run,contentPreparation:{state:'STARTED',draftRevision:f.draft.revision,remaining:[]}}),run.id);assert.equal(progress.getProgressPresentation(run.draftId)?.resultUnknown,true,'legacy STARTED without operation keeps its existing unknown guard');
 }finally{db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(raw,run.id);await progress.close();db.close();}
});
