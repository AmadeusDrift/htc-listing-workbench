import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,chat} from './fixtures/listing-ai.ts';
import {parseFullGeneration,assertFullEvidence,assertFullReview} from '../src/main/listing-ai/full-schema.ts';
import {ListingAiService} from '../src/main/listing-ai/service.ts';
import {randomUUID} from 'node:crypto';
const shape={type:'array',items:{type:'object',properties:{value:{type:'string'}}}};
test('selected SKU image identity is a traceable full-schema citation without inventing a text fact',async t=>{
 const f=await fixture(t,{item_shape:shape}),c=f.listing.currentContext(f.draft,f.product,f.amazon.executionTargetScope(f.draft.targetId).generation),id=f.product.assets[0].id;
 const raw={kind:'amazon-fields',candidates:[{field:'item_shape',nativeValue:[{value:'Round'}],evidenceIds:[id],transformation:'infer',inferenceReason:'Visible shape in the referenced selected product image.'}],missing:[]};
 const before=JSON.stringify(c),output=parseFullGeneration(raw,c);assert.equal(output.candidates.length,1);assert.deepEqual(output.candidates[0].items[0].evidenceIds,[id]);assert.equal(JSON.stringify(c),before);
 assert.doesNotThrow(()=>assertFullEvidence(output,c));assert.doesNotThrow(()=>assertFullReview({kind:'amazon-fields-review',verdict:'PASS',checks:[{field:'item_shape',index:0,verdict:'SUPPORTED',evidenceIds:[id],reason:'Visible',claims:[]}],issues:[]},output,c));
 const foreign=structuredClone(c);foreign.sourceProduct!.assets[0].variantIds=[randomUUID()];assert.equal(parseFullGeneration(raw,foreign).candidates.length,0);assert.throws(()=>assertFullEvidence(output,foreign));
 const absent=structuredClone(c);absent.sourceProduct!.assets=[];assert.equal(parseFullGeneration(raw,absent).candidates.length,0);
});
test('image citation survives adoption history and current evidence checks without extra requests',async t=>{
 const f=await fixture(t,{item_shape:shape}),listing=new ListingAiService(f.store,f.amazon,f.ai,()=>false),id=f.product.assets[0].id;
 f.respond(()=>chat({kind:'amazon-fields',candidates:[{field:'item_shape',nativeValue:[{value:'Round'}],evidenceIds:[id],transformation:'infer',inferenceReason:'Visible outline in the linked product photo.'}],missing:[]}));
 const result=await listing.suggest(f.reference);const draft=await listing.adopt({...f.reference,suggestionResultId:result.id,reviewResultId:null,fields:['item_shape']});
 assert.deepEqual(draft.attributes.item_shape,[{value:'Round'}]);assert.equal(f.requests.length,1);assert.deepEqual(f.ai.getResult(result.id)?.output,result.output);
 await assert.doesNotReject(()=>listing.snapshotCurrentForImages({draftId:draft.id,draftRevision:draft.revision}));assert.equal(f.requests.length,1);
});
