import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, candidateFor, reviewFor, chat } from './fixtures/listing-ai.ts';
test('A19 candidate review upgrades uncertainty once using frozen native target and retains both owners',async t=>{
 const f=await fixture(t);let count=0;
 f.respond(payload=>{if(!payload.candidate)return chat(candidateFor(payload));const out=reviewFor(payload);if(++count===1){out.verdict='NEEDS_CHANGES';const c=out.checks[0];c.verdict='UNSUPPORTED';c.reason='Insufficient evidence for this claim';c.claims[0].verdict='UNSUPPORTED';c.claims[0].reason=c.reason;out.issues.push({field:c.field,message:c.reason} as never);}return chat(out);});
 const p=f.ai.getPurposeProfiles().find(v=>v.purposeId==='copy_review_difficult')!;
 f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'deepseek',model:'deepseek-flash',effort:'high'}});
 const suggestion=await f.listing.suggest(f.reference),review=await f.listing.review({...f.reference,suggestionResultId:suggestion.id});
 assert.equal(count,2);assert.equal(review.model,'deepseek-flash');assert.equal((review.output as any).verdict,'PASS');
 assert.equal(f.ai.listCalls().length,3);assert.equal(f.ai.listResults(f.product.id).filter(r=>r.output.kind==='amazon-fields-review').length,2);
 const again=await f.ai.listingFields(suggestion.listingContext!,async()=>{},{suggestionId:suggestion.id,candidate:suggestion.output as any});assert.equal(again.id,review.id);assert.equal(count,2);
 const explicit=await f.listing.review({...f.reference,suggestionResultId:suggestion.id});assert.notEqual(explicit.id,review.id);assert.equal(count,3);
});
import { readCopyReview,assertCopyReviewHistory,copyReviewResult } from '../src/main/ai/copy-review-upgrade.ts';
import { openDatabase } from '../src/main/database.ts';
import { AiService } from '../src/main/ai/service.ts';
import { mockStorage } from './fixtures/listing-ai.ts';
function uncertain(payload:any){const out=reviewFor(payload);out.verdict='BLOCKED';out.checks[0].verdict='CONTRADICTED';out.checks[0].reason='Conflicting source evidence requires independent review';out.checks[0].claims[0].verdict='CONTRADICTED';out.checks[0].claims[0].reason=out.checks[0].reason;out.issues=[{field:out.checks[0].field,message:out.checks[0].reason}] as any;return out;}
function target(f:any,model='deepseek-flash'){const p=f.ai.getPurposeProfiles().find((v:any)=>v.purposeId==='copy_review_difficult');f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'deepseek',model,effort:'high'}});}
test('A19 crash after first durable result resumes frozen target despite global edits',async t=>{
 const f=await fixture(t);target(f);let reviews=0,stop=true;f.respond(p=>chat(p.candidate?(++reviews===1?uncertain(p):reviewFor(p)):candidateFor(p)));
 const suggestion=await f.listing.suggest(f.reference),context=suggestion.listingContext!,candidate=suggestion.output as any;
 const fresh=async()=>{if(stop&&f.ai.listResults(f.product.id).some(r=>r.output.kind==='amazon-fields-review'))throw new Error('simulated process boundary');};
 await assert.rejects(f.ai.listingFields(context,fresh,{suggestionId:suggestion.id,candidate}),/simulated/);assert.equal(reviews,1);target(f,'deepseek-v4-pro');stop=false;
 const restarted=new AiService(f.directory,f.store,f.hosting,mockStorage,{fetch:async(_url,options)=>{reviews++;const p=JSON.parse(JSON.parse(String(options?.body)).messages[1].content);return chat(reviewFor(p));}});
 const result=await restarted.listingFields(context,async()=>{},{suggestionId:suggestion.id,candidate});assert.equal(reviews,2);assert.equal(result.model,'deepseek-flash');await restarted.close();
 const db=openDatabase(f.directory);try{assertCopyReviewHistory(db);const op=readCopyReview(db,f.ai.listResults(f.product.id).find(r=>r.output.kind==='amazon-fields-review')!.callId)!;assert.equal(op.reason?.includes('CONTRADICTED'),true);assert.equal(copyReviewResult(db,op,true)?.id,result.id);}finally{db.close();}
});
test('A19 unknown second result blocks repeated resume and never reissues successful candidate or first review',async t=>{
 const f=await fixture(t);target(f);let reviews=0;f.respond(p=>{if(!p.candidate)return chat(candidateFor(p));if(++reviews===1)return chat(uncertain(p));throw new Error('unknown paid response');});
 const suggestion=await f.listing.suggest(f.reference),input={...f.reference,suggestionResultId:suggestion.id};await assert.rejects(f.listing.review(input));await assert.rejects(f.listing.review(input),/未自动重发/);assert.equal(reviews,2);assert.equal(f.requests.length,3);
});
test('A19 no configured target is explicit and retains first result without extra charge',async t=>{
 const f=await fixture(t),p=f.ai.getPurposeProfiles().find(v=>v.purposeId==='copy_review')!;f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{upgradePurposeId:null}});f.respond(p=>chat(p.candidate?uncertain(p):candidateFor(p)));
 const suggestion=await f.listing.suggest(f.reference);await assert.rejects(f.listing.review({...f.reference,suggestionResultId:suggestion.id}),/未指定升级目标/);assert.equal(f.requests.length,2);
});
test('A19 current-copy review uses same frozen upgrade without synthetic candidate generation',async t=>{
 const f=await fixture(t);target(f);let calls=0;
 f.respond(p=>{const out={kind:'amazon-fields-review',verdict:++calls===1?'NEEDS_CHANGES':'PASS',checks:p.candidate.candidates.flatMap((c:any)=>c.items.map((_:any,index:number)=>({field:c.field,index,verdict:calls===1?'UNSUPPORTED':'SUPPORTED',evidenceIds:[],reason:'Evidence needs independent check',claims:[]}))),issues:calls===1?[{field:'item_name',message:'Evidence needs independent check'}]:[]};return chat(out);});
 const context=f.listing.currentContext(f.draft,f.product,f.amazon.executionTargetScope(f.draft.targetId).generation),copy=[{field:'item_name',values:['Blue Silicone Coaster']}];
 const result=await f.ai.reviewCurrentListing(context,copy,async()=>{});assert.equal(calls,2);assert.equal(result.output.kind,'listing-current-review');assert.equal(result.model,'deepseek-flash');assert.notEqual((await f.ai.reviewCurrentListing(context,copy,async()=>{})).id,result.id);assert.equal(calls,3,'an explicit fresh completed current-copy review remains independent');
});
test('A19 completion adoption records actual second owner and resumes with zero new requests',async t=>{
 const f=await fixture(t);target(f);let reviews=0;f.respond(p=>chat(p.candidate?(++reviews===1?uncertain(p):reviewFor(p)):candidateFor(p)));
 f.amazon.previewDraft=async()=>{const draft=f.amazon.getDraft(f.draft.id);return {...draft,state:draft.fieldAdoptions?.length?'AMAZON_VALIDATED':'BLOCKED',previewIssues:draft.fieldAdoptions?.length?[]:[{code:'90220',message:'Missing material',severity:'ERROR',attributeNames:['material'],autoFixable:false,source:'amazon',category:'field'}]};};
 const result=await f.listing.complete(f.reference),op=f.listing.completionOperations(f.draft.id)[0],round=op.rounds[0];assert.equal(result.aiCalls,3);assert.notEqual(round.review?.resultId,round.reviewFinalResultId);assert.equal(result.draft.fieldAdoptions?.[0].reviewResultId,round.reviewFinalResultId);assert.equal(f.ai.getResult(round.reviewFinalResultId!)?.model,'deepseek-flash');
 const db=openDatabase(f.directory);try{const {assertCompletionHistory}=await import('../src/main/listing-ai/completion-journal.ts');assertCompletionHistory(db);assertCopyReviewHistory(db);}finally{db.close();}
 await f.listing.complete({draftId:result.draft.id,draftRevision:result.draft.revision});assert.equal(f.requests.length,3);
});
import { join } from 'node:path';
import { createWorkspaceBackup,prepareWorkspaceRestore } from '../src/main/backup.ts';
for(const phase of ['before-first','after-first','after-second'] as const)test(`A19 encrypted rollback retains spent upgrade identity: ${phase}`,async t=>{
 const f=await fixture(t);target(f);let count=0;f.respond(p=>chat(p.candidate?(++count===1?uncertain(p):reviewFor(p)):candidateFor(p)));
 const suggestion=await f.listing.suggest(f.reference),context=suggestion.listingContext!,review={suggestionId:suggestion.id,candidate:suggestion.output as any},file=join(f.directory,'copy-review.htcbackup');let stop=phase==='after-first';
 if(phase==='before-first')await createWorkspaceBackup(f.directory,file,'copy-upgrade-synthetic-passphrase');
 if(phase==='after-first'){
  await assert.rejects(f.ai.listingFields(context,async()=>{if(stop&&count>0&&f.ai.listResults(f.product.id).some(r=>r.output.kind==='amazon-fields-review'))throw new Error('pause');},review));
  await createWorkspaceBackup(f.directory,file,'copy-upgrade-synthetic-passphrase');stop=false;
 }
 const result=await f.ai.listingFields(context,async()=>{},review);if(phase==='after-second')await createWorkspaceBackup(f.directory,file,'copy-upgrade-synthetic-passphrase');
 const prepared=await prepareWorkspaceRestore(f.directory,file,'copy-upgrade-synthetic-passphrase'),db=openDatabase(prepared.stagingDirectory);
 try{assertCopyReviewHistory(db);const row=db.prepare('SELECT id FROM ai_copy_review_upgrades').get()!,receipt=readCopyReview(db,String(row.id))!;assert.equal(receipt.first.sent,true);assert.equal(receipt.second?.sent,true);assert.equal(receipt.second?.resultId,phase==='after-second'?result.id:null);if(phase==='before-first')assert.equal(receipt.first.resultId,null);}finally{db.close();}
 assert.equal(count,2);
});
test('A19 cumulative completion retry debt blocks upgrade at the original three-send limit',async t=>{
 const f=await fixture(t);target(f);let reviews=0;f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:'BLOCKED',previewIssues:[{code:'90220',message:'Missing material',severity:'ERROR',attributeNames:['material'],autoFixable:false,source:'amazon',category:'field'}]});
 f.respond(p=>{if(!p.candidate)return chat(candidateFor(p));if(++reviews<3)return Response.json({error:'synthetic authentication rejection'},{status:401});return chat(uncertain(p));});
 await assert.rejects(f.listing.complete(f.reference));await assert.rejects(f.listing.complete(f.reference));await assert.rejects(f.listing.complete(f.reference),/三次请求上限/);assert.equal(reviews,3);assert.equal(f.requests.length,4);assert.equal(f.listing.completionOperations(f.draft.id)[0].rounds.length,1);
});
for(const model of ['openai/gpt-6-luna','openai/gpt-6.1-sol','openai/gpt-6-astra'])test(`A19 ${model} target uses only its OpenRouter key`,async t=>{
 const f=await fixture(t);f.ai.saveConnection({id:'openrouter',apiKey:'openrouter-copy-upgrade-test-key'});f.ai.setEnabled({id:'openrouter-review',enabled:true});const p=f.ai.getPurposeProfiles().find(v=>v.purposeId==='copy_review_difficult')!;f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model,effort:'high'}});
 let reviews=0;f.respond((p,options)=>{if(!p.candidate)return chat(candidateFor(p));reviews++;assert.equal(new Headers(options?.headers).get('authorization'),reviews===1?'Bearer fixture-shared-listing-key':'Bearer openrouter-copy-upgrade-test-key');return chat(reviews===1?uncertain(p):reviewFor(p));});
 const suggestion=await f.listing.suggest(f.reference),review=await f.listing.review({...f.reference,suggestionResultId:suggestion.id});assert.equal(review.model,model);assert.equal(review.providerId,'openrouter-review');assert.equal(reviews,2);
});

test('A19 abort after first commit preserves frozen chain and resumes only the second call',async t=>{
 const f=await fixture(t);target(f);let reviews=0;f.respond(p=>chat(p.candidate?(++reviews===1?uncertain(p):reviewFor(p)):candidateFor(p)));
 const suggestion=await f.listing.suggest(f.reference),controller=new AbortController(),args={suggestionId:suggestion.id,candidate:suggestion.output as any};
 await assert.rejects(f.ai.listingFields(suggestion.listingContext!,async()=>{if(f.ai.listResults(f.product.id).some(r=>r.output.kind==='amazon-fields-review'))controller.abort();},args,controller.signal));assert.equal(reviews,1);
 await f.ai.listingFields(suggestion.listingContext!,async()=>{},args);assert.equal(reviews,2);
});
test('A19 unconfigured frozen target reports its channel and never borrows native credentials',async t=>{
 const f=await fixture(t),p=f.ai.getPurposeProfiles().find(v=>v.purposeId==='copy_review_difficult')!;f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-astra',effort:'high'}});f.respond(p=>chat(p.candidate?uncertain(p):candidateFor(p)));
 const suggestion=await f.listing.suggest(f.reference);await assert.rejects(f.listing.review({...f.reference,suggestionResultId:suggestion.id}),/openrouter.*未配置|未启用/);assert.equal(f.requests.length,2);
});
test('A19 crash before final adoption resumes the exact completed pair without any additional charge',async t=>{
 const f=await fixture(t);target(f);let reviews=0;f.respond(p=>chat(p.candidate?(++reviews===1?uncertain(p):reviewFor(p)):candidateFor(p)));
 f.amazon.previewDraft=async()=>{const draft=f.amazon.getDraft(f.draft.id);return {...draft,state:draft.fieldAdoptions?.length?'AMAZON_VALIDATED':'BLOCKED',previewIssues:draft.fieldAdoptions?.length?[]:[{code:'90220',message:'Missing material',severity:'ERROR',attributeNames:['material'],autoFixable:false,source:'amazon',category:'field'}]};};
 const adopt=f.listing.adopt.bind(f.listing);f.listing.adopt=async()=>{throw new Error('process exit before adopt');};await assert.rejects(f.listing.complete(f.reference),/before adopt/);assert.equal(f.requests.length,3);f.listing.adopt=adopt;
 const done=await f.listing.complete(f.reference);assert.equal(f.requests.length,3);assert.equal(done.aiCalls,0);assert.equal(done.draft.fieldAdoptions?.length,1);
});
test('A19 receipt validators reject replaced call ownership, scope and frozen target',async t=>{
 const f=await fixture(t);target(f);let count=0;f.respond(p=>chat(p.candidate?(++count===1?uncertain(p):reviewFor(p)):candidateFor(p)));const suggestion=await f.listing.suggest(f.reference);await f.listing.review({...f.reference,suggestionResultId:suggestion.id});
 const db=openDatabase(f.directory);try{const row=db.prepare('SELECT id,record_json FROM ai_copy_review_upgrades').get()!,original=JSON.parse(String(row.record_json));
  for(const mutate of [(r:any)=>{r.second.callId=r.first.callId;},(r:any)=>{r.scopeHash='a'.repeat(64);},(r:any)=>{r.snapshot.upgrade.model='deepseek-v4-pro';r.snapshot.upgrade.capability.model='deepseek-v4-pro';},(r:any)=>{r.reason='Forged reasoning';}]){const record=structuredClone(original);mutate(record);db.prepare('UPDATE ai_copy_review_upgrades SET record_json=? WHERE id=?').run(JSON.stringify(record),row.id);assert.throws(()=>assertCopyReviewHistory(db));db.prepare('UPDATE ai_copy_review_upgrades SET record_json=? WHERE id=?').run(JSON.stringify(original),row.id);}
  assertCopyReviewHistory(db);
 }finally{db.close();}
});
test('A19 cached review cannot authorize altered candidate bytes under the same suggestion identity',async t=>{
 const f=await fixture(t),suggestion=await f.listing.suggest(f.reference);await f.listing.review({...f.reference,suggestionResultId:suggestion.id});const candidate=structuredClone(suggestion.output) as any;candidate.candidates[0].items[0].value='Invented material';
 await assert.rejects(f.ai.listingFields(suggestion.listingContext!,async()=>{},{suggestionId:suggestion.id,candidate}),(e:any)=>e.code==='SOURCE_CHANGED');assert.equal(f.requests.length,2);
});
