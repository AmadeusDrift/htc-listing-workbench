import { fixture as listingFixture } from './fixtures/listing-ai.ts';
import { openDatabase } from '../src/main/database.ts';
import { confirmSourceConsistencyFixture } from './helpers/source-consistency-proof.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { consistencyFixture } from './helpers/source-consistency.ts';
import { SourceConsistencyError } from '../src/main/source-image-consistency/proof.ts';
import { ImageWorkflowService } from '../src/main/image-workflow/service.ts';
import { ListingAiService } from '../src/main/listing-ai/service.ts';
import { ExecutionService } from '../src/main/execution/service.ts';
import { approvedWorkflowAssets } from '../src/main/image-workflow/records.ts';

test('complete, recheck, direct listing completion, approved asset getter and manual upload all require current proof',async t=>{
  const f=consistencyFixture(t),p=f.store.getProduct(f.p.id),draft={id:randomUUID(),revision:1,productId:p.id,productRevision:p.revision,variantId:p.variants[0].id,sku:p.variants[0].sku,schema:{parentageLevel:'NONE'},state:'DRAFT'},input={draftId:draft.id,draftRevision:1};
  const workflow=Object.assign(Object.create(ImageWorkflowService.prototype),{closed:false,active:new Map(),activeSources:new Map(),store:f.store,db:f.db,amazon:{getDraft:()=>draft}});
  assert.throws(()=>workflow.complete(input),SourceConsistencyError);
  await assert.rejects(async()=>workflow.recheck({...input,sourceWorkflowId:randomUUID()}),SourceConsistencyError);
  const listing=Object.assign(Object.create(ListingAiService.prototype),{store:f.store,amazon:{getDraft:()=>draft},ai:{completionJournal:{list:()=>[]}}});
  await assert.rejects(listing.complete(input),SourceConsistencyError);
  assert.throws(()=>approvedWorkflowAssets(f.db,draft as never,p),SourceConsistencyError);
  const execution=Object.assign(Object.create(ExecutionService.prototype),{store:f.store,db:f.db,amazon:{getDraft:()=>draft}});
  assert.throws(()=>execution.selectedAssets(draft,p),SourceConsistencyError);
});

test('direct listing paid entries and adoption require real current proof, including adoption transaction checkpoint',async t=>{
  const f=await listingFixture(t),suggestion=await f.listing.suggest(f.reference),review=await f.listing.review({...f.reference,suggestionResultId:suggestion.id}),db=openDatabase(f.directory);
  const adopt={...f.reference,suggestionResultId:suggestion.id,reviewResultId:review.id,fields:['material']},context=suggestion.listingContext!;
  try{
    db.exec('DELETE FROM source_consistency_decisions');const calls=f.requests.length;
    for(const operation of [()=>f.listing.suggest(f.reference),()=>f.listing.review({...f.reference,suggestionResultId:suggestion.id}),()=>f.listing.adopt(adopt),()=>f.ai.listingFields(context,async()=>{}),()=>f.ai.reviewCurrentListing(context,[],async()=>{})])await assert.rejects(operation(),SourceConsistencyError);
    assert.equal(f.requests.length,calls);await confirmSourceConsistencyFixture(f.directory,f.store,f.product.id);
    const original=f.amazon.adoptFields.bind(f.amazon);f.amazon.adoptFields=(...args)=>{db.exec('DELETE FROM source_consistency_decisions');return original(...args);};
    await assert.rejects(f.listing.adopt(adopt),SourceConsistencyError);assert.equal(f.amazon.getDraft(f.draft.id).revision,f.draft.revision);
    f.amazon.adoptFields=original;await confirmSourceConsistencyFixture(f.directory,f.store,f.product.id);assert.equal((await f.listing.adopt(adopt)).revision,f.draft.revision+1);assert.equal(f.requests.length,calls);
  }finally{db.close();}
});

test('listing checks source proof after schema await and after paid provider response',async t=>{
  const f=await listingFixture(t),db=openDatabase(f.directory),getSchema=f.amazon.getSchema.bind(f.amazon);
  try{
    f.amazon.getSchema=async input=>{const schema=await getSchema(input);db.exec('DELETE FROM source_consistency_decisions');return schema;};
    await assert.rejects(f.listing.suggest(f.reference),SourceConsistencyError);assert.equal(f.requests.length,0);
    f.amazon.getSchema=getSchema;await confirmSourceConsistencyFixture(f.directory,f.store,f.product.id);
    const {candidateFor,chat}=await import('./fixtures/listing-ai.ts');f.respond(payload=>{db.exec('DELETE FROM source_consistency_decisions');return chat(candidateFor(payload));});
    await assert.rejects(f.listing.suggest(f.reference));assert.equal(f.requests.length,1);assert.equal(f.ai.listResults(f.product.id).length,0);
  }finally{db.close();}
});
