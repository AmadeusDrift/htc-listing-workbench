import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,holdFetch,isCode} from './fixtures/ai-control.ts';
import {fixture as listingFixture,chat} from './fixtures/listing-ai.ts';
import {openDatabase} from '../src/main/database.ts';
import {taskAiContext} from '../src/main/ai/batch/task-context.ts';
import {RunReportReader} from '../src/main/diagnostics/run-report.ts';
import {localAiRequestResolved} from '../src/main/ai/request-certainty.ts';

function scope(db:ReturnType<typeof openDatabase>,product:{id:string;variants:{id:string}[]},draftId:string=randomUUID(),sku='S02-REPORT-SYNTHETIC'){
  const taskId=randomUUID(),item={key:product.id+':'+product.variants[0].id,productId:product.id,variantId:product.variants[0].id,sku,draftId,stage:'FIELDS',status:'FAILED',executionTaskIds:[]};
  db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(taskId,JSON.stringify({id:taskId,revision:1,status:'PAUSED',items:[item]}));
  return {taskId,item,context:{taskId,rowKey:item.key,phase:'FIELDS',mode:'immediate' as const,authorize:()=>true}};
}
function snapshot(db:ReturnType<typeof openDatabase>){return JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>[row.name,db.prepare('SELECT * FROM "'+String(row.name).replaceAll('"','""')+'" ORDER BY rowid').all()]));}
function assertReadOnly(db:ReturnType<typeof openDatabase>,reader:RunReportReader,taskId:string,posts:()=>number){const before=snapshot(db),count=posts(),changes=db.prepare('SELECT total_changes() n').get()!.n;for(let i=0;i<100;i++)reader.query({taskId});assert.equal(snapshot(db),before);assert.equal(db.prepare('SELECT total_changes() n').get()!.n,changes);assert.equal(posts(),count);}

for(const gateway of ['deepseek','openrouter'] as const)for(const variant of ['401','empty401','utf8401','echo401','503','empty200','utf8200','echo200','partial200','missing200','provider200error'] as const)test(`actual ${gateway} producer private receipt/M07/report ${variant} keeps certainty and 100 reads cannot write or resend`,async t=>{
  const status=variant==='503'?503:variant.endsWith('401')||variant==='401'?401:200;
  const bytes=variant==='401'?Buffer.from('{"error":{"message":"Unauthorized","code":401}}'):variant==='503'?Buffer.from('{"error":{"message":"Unavailable","code":503}}'):variant==='provider200error'?Buffer.from('{"error":{"message":"Processing failed","code":502}}'):variant.startsWith('utf8')?Buffer.from([0xff,0x61]):variant.startsWith('echo')?Buffer.concat([Buffer.from([0xff]),Buffer.from('fixture-api-key')]):variant==='partial200'?Buffer.from('{"choices":'):Buffer.alloc(0);
  const f=await fixture(t,{fetch:async()=>variant==='missing200'?new Response(null,{status}):variant==='partial200'?new Response(new ReadableStream({start(c){c.enqueue(bytes);},pull(c){c.error(Error('synthetic partial'));}}),{status}):new Response(bytes,{status})});f.enable('deepseek');
  if(gateway==='openrouter'){f.service.saveConnection({id:'openrouter',apiKey:'fixture-api-key'});f.service.saveFunctionSettings({id:'openrouter',model:'openai/gpt-6-luna',enabled:true});const p=f.service.getPurposeProfiles().find(p=>p.purposeId==='listing_generation')!;f.service.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-luna',effort:'none'}});}
  const db=openDatabase(f.directory);
  try{const s=scope(db,f.product);await assert.rejects(taskAiContext.run(s.context,()=>f.service.suggest(f.textInput)));const call=f.service.listCalls()[0],reader=new RunReportReader(db),view=reader.query({taskId:s.taskId}).calls.find(c=>c.callId===call.id)!;
    const expected=variant==='401'?'DEFINITIVE_REJECTION':['empty200','utf8200'].includes(variant)?'RECEIVED_INVALID':'SENT_UNKNOWN';assert.equal(view.certainty,expected);assert.equal(view.nextAction,expected==='SENT_UNKNOWN'?'VERIFY_ORIGINAL_REQUEST':'INSPECT_REJECTION_AND_BUDGET');assert.equal(view.receivedBytes,bytes.length);assert.equal(localAiRequestResolved(db,f.directory,call.id,call),expected!=='SENT_UNKNOWN');
    const receipt:any=await f.service.readProviderReceipt(call.id);if(variant.startsWith('echo'))assert.equal(receipt.body,'[omitted: credential echo]');if(variant.startsWith('utf8'))assert.deepEqual(Buffer.from(receipt.body.base64,'base64'),bytes);if(['partial200','missing200'].includes(variant))assert.equal(receipt,null);
    assert.equal(f.service.getUsageSummary(call.providerId).unknownCalls,1);assert.equal(f.requests.length,1);assertReadOnly(db,reader,s.taskId,()=>f.requests.length);assert.deepEqual(f.service.listCalls()[0],call);
  }finally{db.close();}
});

test('legacy metadata without explicit certainty cannot turn an empty receipt or HTTP status into a result',async t=>{
  const f=await fixture(t,{fetch:async()=>new Response('',{status:200})});f.enable('deepseek');const db=openDatabase(f.directory);
  try{const s=scope(db,f.product);await assert.rejects(taskAiContext.run(s.context,()=>f.service.suggest(f.textInput)));db.prepare("UPDATE audit_events SET detail_json=json_remove(detail_json,'$.certainty') WHERE action='run.evidence'").run();const reader=new RunReportReader(db);assert.equal(reader.query({taskId:s.taskId}).calls[0].certainty,'SENT_UNKNOWN');assertReadOnly(db,reader,s.taskId,()=>f.requests.length);}finally{db.close();}
});

test('actual valid late receipt recovery remains a saved result with no new POST or automatic adoption',async t=>{
  const held=holdFetch(),f=await fixture(t,{fetch:held.fetch});f.enable('deepseek');const db=openDatabase(f.directory);
  try{const s=scope(db,f.product),controller=new AbortController(),pending=taskAiContext.run(s.context,()=>f.service.suggest(f.textInput,controller.signal)),rejected=assert.rejects(pending,isCode('CANCELLED'));await held.started;controller.abort();await rejected;held.release();while(f.service.busy)await new Promise(r=>setTimeout(r,5));
    const result=await taskAiContext.run(s.context,()=>f.service.suggest(f.textInput));assert.ok(result.providerReceiptRecovery);const reader=new RunReportReader(db),report=reader.query({taskId:s.taskId});assert.equal(report.calls[0].certainty,'RECEIVED_VALID');assert.equal(report.calls[0].nextAction,'INSPECT_SAVED_RESULT');assert.equal(report.counts.validResults,1);assert.equal(report.counts.adoptedResults,0);assert.equal(f.requests.length,1);assertReadOnly(db,reader,s.taskId,()=>f.requests.length);
  }finally{db.close();}
});

for(const rejectReview of [false,true])test(`actual listing producer ${rejectReview?'rejected review preserves saved candidate':'explicit adoption preserves separate report layers'}`,async t=>{
  const f=await listingFixture(t),db=openDatabase(f.directory);
  try{const s=scope(db,f.product,f.draft.id,f.draft.sku),suggestion=await taskAiContext.run(s.context,()=>f.listing.suggest(f.reference));
    if(rejectReview){f.respond(()=>chat({kind:'amazon-fields-review',checks:null}));await assert.rejects(taskAiContext.run(s.context,()=>f.listing.review({...f.reference,suggestionResultId:suggestion.id})));}
    else{const review=await taskAiContext.run(s.context,()=>f.listing.review({...f.reference,suggestionResultId:suggestion.id}));await taskAiContext.run(s.context,()=>f.listing.adopt({...f.reference,suggestionResultId:suggestion.id,reviewResultId:review.id,fields:['material']}));}
    const reader=new RunReportReader(db),report=reader.query({taskId:s.taskId}),candidate=report.calls.find(c=>c.callId===suggestion.callId)!;assert.equal(candidate.certainty,'RECEIVED_VALID');assert.equal(report.counts.validResults,rejectReview?1:2);assert.equal(report.counts.adoptedResults,rejectReview?0:2);assert.equal(report.counts.submittedSkus,0);assert.equal(report.counts.buyableSkus,0);assert.equal(f.requests.length,2);assertReadOnly(db,reader,s.taskId,()=>f.requests.length);
  }finally{db.close();}
});
