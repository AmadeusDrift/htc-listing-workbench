import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, candidateFor, chat, reviewFor, saveInput } from './fixtures/listing-ai.ts';
import { ListingAiService } from '../src/main/listing-ai/service.ts';
import { openDatabase } from '../src/main/database.ts';

const issue={code:'90220',message:'Missing material',severity:'ERROR' as const,attributeNames:['material'],autoFixable:false,source:'amazon' as const,category:'field' as const};
function savedHistory(directory:string){
  const db=openDatabase(directory);
  try{return Object.fromEntries(['ai_calls','ai_usage_ledger','ai_spend_reservations','listing_completion_operations'].map(table=>[table,db.prepare(`SELECT record_json FROM ${table} ORDER BY id`).all()]));}
  finally{db.close();}
}
function oldObservationPolicy(listing:ListingAiService){
  const current=listing.currentContext.bind(listing);let include=true;
  listing.currentContext=(...args)=>{const context=current(...args);if(include)context.evidence.push({id:'legacy-visible-shape',name:'shape',value:'rounded loop',meaning:'general',source:'image_observation'});return context;};
  return()=>{include=false;};
}

for(const step of ['candidate','review'] as const)test(`unknown ${step} is reported before a changed derived evidence fingerprint without another POST`,async t=>{
  const f=await fixture(t),retireOldEvidence=oldObservationPolicy(f.listing),controller=new AbortController();
  f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:'BLOCKED',previewIssues:[issue]});
  f.respond(payload=>{if(Boolean(payload.candidate)===(step==='review')){controller.abort();throw new DOMException('synthetic cancellation after dispatch','AbortError');}return chat(payload.candidate?reviewFor(payload):candidateFor(payload));});
  await assert.rejects(f.listing.complete(f.reference,controller.signal));
  const op=f.listing.completionOperations(f.draft.id)[0],entry=op.rounds[0][step]!;
  assert.equal(entry.sent,true);assert.equal(entry.resultId,null);assert.equal(f.listing.completionUnknown(op.id),true);
  assert.equal(f.ai.getCall(entry.id)!.errorCode,'CANCELLED');
  const before=savedHistory(f.directory),posts=f.requests.length,draftBefore=f.amazon.getDraft(f.draft.id);
  retireOldEvidence();const restarted=new ListingAiService(f.store,f.amazon,f.ai);
  await assert.rejects(restarted.complete(f.reference,undefined,op.id),/上次字段请求结果尚未确认/);
  assert.equal(f.requests.length,posts);assert.deepEqual(savedHistory(f.directory),before);
  assert.deepEqual(f.amazon.getDraft(f.draft.id),draftBefore);assert.equal(restarted.completionUnknown(op.id),true);
});

test('received original output recovers locally before current evidence changes reject adoption',async t=>{
  const f=await fixture(t),retireOldEvidence=oldObservationPolicy(f.listing);
  f.amazon.previewDraft=async()=>({...f.amazon.getDraft(f.draft.id),state:'BLOCKED',previewIssues:[issue]});
  const fields=f.ai.listingFields.bind(f.ai);
  f.ai.listingFields=async(...args)=>{await fields(...args);retireOldEvidence();throw Error('synthetic caller checkpoint loss');};
  await assert.rejects(f.listing.complete(f.reference),/synthetic caller checkpoint loss/);
  const op=f.listing.completionOperations(f.draft.id)[0],callId=op.rounds[0].candidate.id;
  assert.ok(f.ai.getCall(callId)!.providerReceiptId);assert.ok(op.rounds[0].candidate.resultId);
  op.rounds[0].candidate.resultId=null;f.ai.completionJournal.save(op);
  const before=savedHistory(f.directory),posts=f.requests.length;
  await assert.rejects(new ListingAiService(f.store,f.amazon,f.ai).complete(f.reference,undefined,op.id),/来源、店铺或规则/);
  const after=savedHistory(f.directory),recovered=f.listing.getCompletion(op.id).rounds[0].candidate.resultId;
  assert.ok(recovered);assert.equal(f.ai.getResult(recovered)!.callId,callId);
  assert.equal(f.ai.getResult(recovered)!.sourceSha256,op.rounds[0].contextHash);
  assert.deepEqual(after.ai_calls,before.ai_calls);assert.deepEqual(after.ai_usage_ledger,before.ai_usage_ledger);assert.deepEqual(after.ai_spend_reservations,before.ai_spend_reservations);
  assert.equal(f.requests.length,posts);assert.equal(f.amazon.getDraft(f.draft.id).fieldAdoptions?.length??0,0);
});

test('a never-sent frozen round still rejects actual source changes without a POST',async t=>{
  const f=await fixture(t);f.amazon.previewDraft=async()=>{throw Error('synthetic preview unavailable');};
  await assert.rejects(f.listing.complete(f.reference));
  const op=f.listing.completionOperations(f.draft.id)[0],before=savedHistory(f.directory);
  const product=f.store.getProduct(f.product.id);
  f.store.saveProduct({...saveInput(product),title:'Changed source'});
  await assert.rejects(new ListingAiService(f.store,f.amazon,f.ai).complete(f.reference,undefined,op.id),/来源商品或 SKU/);
  assert.equal(f.requests.length,0);assert.deepEqual(savedHistory(f.directory),before);
});
