import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, saveInput, chat } from './fixtures/listing-ai.ts';
import { ListingAiService } from '../src/main/listing-ai/service.ts';
import { listingFingerprint, validateListingContext, assertListingEvidence } from '../src/main/listing-ai/validation.ts';
import type { AiResult } from '../src/shared/ai-contracts.ts';
import type { SourceColorContext } from '../src/shared/source-color-contracts.ts';

async function setup(t:test.TestContext, spec='602Q',requiredColor=true) {
  const f=await fixture(t);
  const getSchema=f.amazon.getSchema.bind(f.amazon);f.amazon.getSchema=async input=>{const schema=await getSchema(input);const required=(schema.schema.required as string[]??[]).filter(name=>name!=='color');schema.schema.required=requiredColor?[...required,'color']:required;return schema;};
  const product=f.store.saveProduct({...saveInput(f.product),variants:saveInput(f.product).variants.map(v=>({...v,originalSpec:spec,normalizedSpec:spec}))});
  const draft=await f.amazon.createDraft({productId:product.id,variantId:product.variants[0].id,targetId:f.draft.targetId,productType:f.draft.schema.productType,parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'});
  const context:SourceColorContext={policyVersion:'source-color/v1',productId:product.id,productRevision:product.revision,variantId:product.variants[0].id,sourceSpec:spec,referenceAssets:[{assetId:randomUUID(),sha256:'a'.repeat(64)}]};
  const results:AiResult[]=[],calls:any[]=[];let observed=0,verdict:'DETERMINED'|'UNCERTAIN'='DETERMINED',fresh=true;
  const originalResults=f.ai.listResults.bind(f.ai),originalGet=f.ai.getResult.bind(f.ai),originalCall=f.ai.getCall.bind(f.ai),originalCalls=f.ai.listCalls.bind(f.ai);
  f.ai.sourceColorContext=()=>structuredClone(context);
  f.ai.assertSourceColorFresh=async()=>{if(!fresh)throw Error('source bytes changed');};
  f.ai.observeSourceColor=async(c,check)=>{observed++;await check();const at=new Date().toISOString(),callId=randomUUID();
    const result:AiResult={id:randomUUID(),callId,providerId:'deepseek',productId:product.id,productRevision:product.revision,variantId:context.variantId,assetId:null,assetSha256:null,sourceResultIds:[],model:'deepseek-flash',createdAt:at,reviewState:'unreviewed',sourceSha256:listingFingerprint(c),sourceColorContext:c,sourceColorRequestBytes:1000,output:{kind:'source-color',verdict,colors:verdict==='DETERMINED'?['Silver']:[],reason:'Observed from original image.',referenceAssetIds:c.referenceAssets.map(a=>a.assetId)}};
    calls.push({id:callId,providerId:'deepseek',productId:product.id,productRevision:product.revision,status:'SUCCEEDED',model:'deepseek-flash',finishedAt:at,sourceColorContext:c});results.push(result);return result as any;};
  f.ai.listResults=id=>[...originalResults(id),...results];f.ai.getResult=id=>results.find(r=>r.id===id)??originalGet(id);f.ai.getCall=id=>calls.find(c=>c.id===id)??originalCall(id);f.ai.listCalls=()=>[...originalCalls(),...calls];
  const listing=new ListingAiService(f.store,f.amazon,f.ai,()=>false),reference={draftId:draft.id,draftRevision:draft.revision};
  return {...f,product,draft,listing,reference,context,results,calls,observed:()=>observed,setUncertain:()=>{verdict='UNCERTAIN';},stale:()=>{fresh=false;}};
}

test('source image color prepares once, survives a new service and becomes typed evidence without changing product facts',async t=>{
  const f=await setup(t),before=f.store.getProduct(f.product.id);
  const prepared=await (f.listing as any).prepareSourceColors(f.reference);
  assert.equal(prepared.aiCalls,1);assert.equal(prepared.evidenceChanged,true);assert.match(prepared.evidenceSha256,/^[a-f0-9]{64}$/);
  const context=(f.listing as any).currentContext(f.draft,f.product,0),e=context.evidence.find((e:any)=>e.source==='source_image');
  assert.equal(e.value,'Silver');assert.equal(e.meaning,'color');assert.deepEqual(e.imageObservation.context,f.context);
  assert.deepEqual(validateListingContext(context),context);
  assert.doesNotThrow(()=>assertListingEvidence({kind:'amazon-fields',candidates:[{field:'color',items:[{value:'Silver',evidenceIds:[e.id],transformation:'copy'}]}],missing:[]},context));
  const restarted=new ListingAiService(f.store,f.amazon,f.ai,()=>false),again=await (restarted as any).prepareSourceColors(f.reference);
  assert.equal(again.aiCalls,0);assert.equal(again.evidenceSha256,prepared.evidenceSha256);assert.equal(f.observed(),1);
  assert.deepEqual(f.store.getProduct(f.product.id),before);assert.deepEqual(f.amazon.getDraft(f.draft.id),f.draft);
});

test('explicit SKU colors do not invoke vision or get overridden by image observations',async t=>{
  const f=await setup(t,'Blue');const result=await (f.listing as any).prepareSourceColors(f.reference);
  assert.equal(result.aiCalls,0);assert.equal(f.observed(),0);assert.equal(result.evidenceSha256,undefined);
});

test('uncertain observation is retained and does not trigger another paid attempt or positive evidence',async t=>{
  const f=await setup(t);f.setUncertain();
  await assert.rejects((f.listing as any).prepareSourceColors(f.reference),/颜色.*无法确定|来源图.*颜色/);
  await assert.rejects((new ListingAiService(f.store,f.amazon,f.ai,()=>false) as any).prepareSourceColors(f.reference),/颜色.*无法确定|来源图.*颜色/);
  assert.equal(f.observed(),1);
  assert.equal((f.listing as any).currentContext(f.draft,f.product,0).evidence.some((e:any)=>e.source==='source_image'),false);
});

test('matching failed or interrupted source-color call is not automatically resent',async t=>{
  const f=await setup(t);f.calls.push({id:randomUUID(),providerId:'deepseek',productId:f.product.id,productRevision:f.product.revision,status:'FAILED',model:'deepseek-flash',sourceColorContext:f.context,errorCode:'INTERRUPTED'});
  await assert.rejects((f.listing as any).prepareSourceColors(f.reference),/上次.*颜色|颜色.*结果/);assert.equal(f.observed(),0);
});

test('image color evidence can populate color with review disabled and rejects changed image bytes before AI',async t=>{
  const f=await setup(t);await (f.listing as any).prepareSourceColors(f.reference);
  f.respond(p=>{const e=p.evidence.find((e:any)=>e.source==='source_image');return chat({kind:'amazon-fields',candidates:[{field:'color',items:[{value:e.value,evidenceIds:[e.id],transformation:'copy'}]}],missing:p.fields.filter((x:any)=>x.name!=='color').map((x:any)=>({field:x.name,reason:'Not needed in this test.'}))});});
  const suggestion=await f.listing.suggest(f.reference);
  const adopted=await f.listing.adopt({...f.reference,suggestionResultId:suggestion.id,reviewResultId:null,fields:['color']});
  assert.equal((adopted.attributes.color as any)[0].value,'Silver');assert.equal(adopted.fieldAdoptions?.at(-1)?.changes[0].evidence[0].source,'source_image');
  const count=f.requests.length;f.stale();await assert.rejects(f.listing.suggest({draftId:adopted.id,draftRevision:adopted.revision}),/source bytes changed/);assert.equal(f.requests.length,count);
});

test('source image evidence cannot claim another variant, material or a value absent from the observation',async t=>{
  const f=await setup(t);await (f.listing as any).prepareSourceColors(f.reference);const context=(f.listing as any).currentContext(f.draft,f.product,0);
  const e=context.evidence.find((e:any)=>e.source==='source_image');
  for(const change of [{id:randomUUID()+':source-color:'+e.imageObservation.resultId},{meaning:'material'},{value:'Gold'},{source:'human_confirmed'}]){
    const bad=structuredClone(context);Object.assign(bad.evidence.find((x:any)=>x.id===e.id),change);assert.throws(()=>validateListingContext(bad));
  }
});

test('valid existing and optional colors do not become blocked by an uncertain image observation',async t=>{
  const f=await setup(t);f.setUncertain();
  const draft=f.amazon.saveDraft({id:f.draft.id,revision:f.draft.revision,attributes:{...f.draft.attributes,color:[{value:'Silver',marketplace_id:f.draft.marketplaceId,language_tag:'en_US'}]}});
  const prepared=await (f.listing as any).prepareSourceColors({draftId:draft.id,draftRevision:draft.revision});
  assert.equal(prepared.aiCalls,0);assert.equal(f.observed(),0);
  const optional=await setup(t,'602Q',false);optional.setUncertain();
  const skipped=await (optional.listing as any).prepareSourceColors(optional.reference);assert.equal(skipped.aiCalls,0);assert.equal(optional.observed(),0);
});

for(const knownRejection of [false,true])test(`optional color discovered by ${knownRejection?'known submission rejection':'first preview'} prepares source evidence before field generation`,async t=>{
  const f=await setup(t,'602Q',false);
  const missingColor={code:'90220',message:'Color is required',severity:'ERROR' as const,attributeNames:['color'],autoFixable:false,source:'amazon' as const,category:'field' as const};
  let previews=0;
  if(knownRejection){
    const getDraft=f.amazon.getDraft.bind(f.amazon);f.amazon.wasSubmissionRejected=()=>true;
    f.amazon.getDraft=id=>({...getDraft(id),listingIssues:[missingColor]});
  }
  f.amazon.previewDraft=async()=>{
    const draft=f.amazon.getDraft(f.draft.id);previews++;
    return {...draft,state:knownRejection||draft.attributes.color?'AMAZON_VALIDATED':'BLOCKED',previewIssues:knownRejection||draft.attributes.color?[]:[missingColor]};
  };
  f.respond(payload=>{
    const evidence=payload.evidence.find((entry:any)=>entry.source==='source_image');
    assert.ok(evidence,'field repair needs the source-image observation even when the original schema marks color optional');
    return chat({kind:'amazon-fields',candidates:[{field:'color',items:[{value:'Silver',evidenceIds:[evidence.id],transformation:'copy'}]}],missing:[]});
  });
  const result=await f.listing.complete(f.reference);
  assert.deepEqual(result.remaining,[]);assert.equal((result.draft.attributes.color as any)[0].value,'Silver');
  assert.equal(result.aiCalls,2);assert.equal(f.observed(),1);assert.equal(f.requests.length,1);assert.equal(previews,2);
});
