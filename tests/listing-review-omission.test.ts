import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, legacyFixture, candidateFor, chat, reviewFor } from './fixtures/listing-ai.ts';
const issue={code:'90220',message:'Missing description',severity:'ERROR' as const,attributeNames:['product_description'],autoFixable:false,source:'amazon' as const,category:'field' as const};
for(const legacy of [false,true])for(const exhaust of [false,true])test(`review omission retries only review, legacy=${legacy}, exhaust=${exhaust}`,async t=>{
 const f=await (legacy?legacyFixture:fixture)(t);let reviews=0;
 f.amazon.previewDraft=async()=>{const d=f.amazon.getDraft(f.draft.id);return {...d,state:d.fieldAdoptions?.length?'AMAZON_VALIDATED':'BLOCKED',previewIssues:d.fieldAdoptions?.length?[]:[issue]};};
 f.respond(p=>{if(!p.candidate)return chat(candidateFor(p));const r=reviewFor(p);if(++reviews===1||exhaust){if(legacy)r.checks[0].claims[0].text='blue silicone';else r.checks=[];}return chat(r);});
 if(exhaust){await assert.rejects(f.listing.complete(f.reference),/三次/);await assert.rejects(f.listing.complete(f.reference),/三次/);}
 else {const result=await f.listing.complete(f.reference);assert.equal(result.aiCalls,3);assert.equal(result.draft.fieldAdoptions?.length,1);}
 assert.equal(f.requests.filter(r=>!JSON.parse(r.messages[1].content).candidate).length,1);
 const op=f.listing.completionOperations(f.draft.id)[0];assert.equal(op.rounds.length,1);assert.equal(op.rounds[0].review?.previous?.length,exhaust?2:1);
 assert.equal(f.ai.getCall(op.rounds[0].review!.previous![0].id)?.status,'FAILED');
 assert.equal(op.reviewIssues.length,0);assert.equal(reviews,exhaust?3:2);
 const payloads=f.requests.slice(1).map(r=>JSON.parse(r.messages[1].content));for(const p of payloads)assert.deepEqual(p,payloads[0]);
});
import { AiService } from '../src/main/ai/service.ts';
import { ListingAiService } from '../src/main/listing-ai/service.ts';
import { mockStorage } from './fixtures/listing-ai.ts';
import { readFileSync,readdirSync } from 'node:fs';
import { join } from 'node:path';

test('restart resumes only omitted review and retains failed raw output, ledger and candidate identity',async t=>{
 const f=await fixture(t),controller=new AbortController();
 f.amazon.previewDraft=async()=>{const d=f.amazon.getDraft(f.draft.id);return {...d,state:d.fieldAdoptions?.length?'AMAZON_VALIDATED':'BLOCKED',previewIssues:d.fieldAdoptions?.length?[]:[issue]};};
 f.respond(p=>chat(p.candidate?{...reviewFor(p),checks:[]}:candidateFor(p)));
 const original=f.ai.listingFields.bind(f.ai);
 f.ai.listingFields=async(...args)=>{try{return await original(...args);}catch(e){controller.abort();throw e;}};
 await assert.rejects(f.listing.complete(f.reference,controller.signal));
 const op=f.listing.completionOperations(f.draft.id)[0],candidateId=op.rounds[0].candidate.resultId,failedId=op.rounds[0].review!.id;
 const rawPath=join(f.directory,'ai-diagnostics',readdirSync(join(f.directory,'ai-diagnostics')).find(n=>n.endsWith(failedId+'.json'))!);
 const before=readFileSync(rawPath,'utf8');await f.ai.close();let sends=0;
 const restarted=new AiService(f.directory,f.store,f.hosting,mockStorage,{fetch:async(_url,options)=>{sends++;const p=JSON.parse(JSON.parse(String(options?.body)).messages[1].content);assert.ok(p.candidate);return chat(reviewFor(p));}});
 try{const listing=new ListingAiService(f.store,f.amazon,restarted),result=await listing.complete(f.reference,undefined,op.id);
 assert.equal(sends,1);assert.equal(result.draft.fieldAdoptions?.length,1);assert.equal(listing.getCompletion(op.id).rounds[0].candidate.resultId,candidateId);
 assert.equal(restarted.getCall(failedId)?.status,'FAILED');assert.equal(restarted.getUsageSummary('deepseek-review').attempts,2);assert.equal(readFileSync(rawPath,'utf8'),before);
 }finally{await restarted.close();}
});

for(const mode of ['malformed','extra-check','foreign-evidence','negative'] as const)test(`review ${mode} never enters omission retry`,async t=>{
 const f=await fixture(t);f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:'BLOCKED',previewIssues:[issue]});
 f.respond(p=>{if(!p.candidate)return chat(candidateFor(p));const r:any=reviewFor(p);if(mode==='malformed')r.checks=null;else if(mode==='extra-check')r.checks[0].field='foreign';else if(mode==='foreign-evidence')r.checks[0].evidenceIds=['foreign'];else{r.verdict='NEEDS_CHANGES';r.issues=[{field:'product_description',message:'Unsupported function'}];}return chat(r);});
 if(mode==='negative'){const result=await f.listing.complete(f.reference);assert.equal(result.draft.fieldAdoptions?.length??0,0);assert.equal(f.requests.length,4);}
 else{await assert.rejects(f.listing.complete(f.reference));await assert.rejects(f.listing.complete(f.reference));assert.equal(f.requests.length,2);}
});

test('current whole-field review accepts ordinary display wording and connecting phrases without per-word claims',async t=>{
 const f=await fixture(t);f.respond(p=>{if(p.candidate){const r=reviewFor(p);r.checks.forEach((c:any)=>c.claims=[]);return chat(r);}const r=candidateFor(p);r.candidates.find((c:any)=>c.field==='product_description')!.items[0].value='A coaster designed for display, adding a playful touch as a decorative accent.';return chat(r);});
 const suggestion=await f.listing.suggest(f.reference),review=await f.listing.review({...f.reference,suggestionResultId:suggestion.id});
 assert.equal(review.output.kind==='amazon-fields-review'&&review.output.verdict,'PASS');
});

test('review omissions do not consume the two candidate repair rounds or erase a real rejection',async t=>{
 const f=await fixture(t);let reviews=0;
 // Ordinary editorial rejection isolates omission and candidate budgets; factual uncertainty has its own A19 upgrade tests.
 f.amazon.previewDraft=async()=>{const d=f.amazon.getDraft(f.draft.id);return {...d,state:d.fieldAdoptions?.length?'AMAZON_VALIDATED':'BLOCKED',previewIssues:d.fieldAdoptions?.length?[]:[issue]};};
 f.respond(p=>{if(!p.candidate)return chat(candidateFor(p));const r:any=reviewFor(p);reviews++;if(reviews===1||reviews===3)r.checks=[];if(reviews===2){r.verdict='NEEDS_CHANGES';r.issues=[{field:'product_description',message:'Resin wording should be clarified for readability'}];}return chat(r);});
 const result=await f.listing.complete(f.reference),op=f.listing.completionOperations(f.draft.id)[0];
 assert.equal(result.aiCalls,6);assert.equal(op.rounds.length,2);assert.equal(result.draft.fieldAdoptions?.length,1);
 assert.ok(op.rounds.every(r=>r.review?.previous?.length===1));
 const secondCandidate=JSON.parse(f.requests[3].messages[1].content);assert.deepEqual(secondCandidate.fields.map((f:any)=>f.name),['product_description']);
 assert.ok(secondCandidate.repairRequest.issues.some((i:any)=>i.message.includes('Resin')));
 assert.equal((f.ai.getResult(op.rounds[0].review!.resultId!)!.output as any).verdict,'NEEDS_CHANGES');
});

import { isReviewCoverageOmission } from '../src/main/listing-ai/review-omission.ts';
import { assertFullReview,parseFullReview } from '../src/main/listing-ai/full-schema.ts';
test('partial review accepts the same bound image references as complete full-schema review',async t=>{
 const f=await fixture(t),suggestion=await f.listing.suggest(f.reference),context=suggestion.listingContext!;
 assert.equal(suggestion.output.kind,'amazon-fields');if(suggestion.output.kind!=='amazon-fields')throw Error('candidate');
 const candidate=suggestion.output,asset=context.sourceProduct!.assets.find(a=>a.variantIds.includes(context.variantId))!;assert.ok(asset);
 const review=reviewFor({candidate});review.checks.forEach((check:any)=>{check.evidenceIds=[asset.id];check.claims=[];});
 assert.doesNotThrow(()=>assertFullReview(parseFullReview(review),candidate,context));
 const partial={...review,checks:review.checks.slice(0,1)};assert.ok(partial.checks.length<candidate.candidates.length);
 assert.equal(isReviewCoverageOmission(partial,candidate,context),true);
 for(const badContext of [
   {...context,sourceProduct:{...context.sourceProduct!,assets:context.sourceProduct!.assets.filter(a=>a.id!==asset.id)}},
   {...context,sourceProduct:{...context.sourceProduct!,assets:context.sourceProduct!.assets.map(a=>a.id===asset.id?{...a,variantIds:['foreign-sku']}:a)}},
   {...context,sourceProduct:{...context.sourceProduct!,selectedSku:{...context.sourceProduct!.selectedSku,id:'foreign-sku'}}},
 ])assert.equal(isReviewCoverageOmission(partial,candidate,badContext),false);
 const foreign=structuredClone(partial);foreign.checks[0].evidenceIds=['foreign-image'];assert.equal(isReviewCoverageOmission(foreign,candidate,context),false);
});
