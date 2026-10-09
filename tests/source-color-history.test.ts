import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { AiCall, AiResult } from '../src/shared/ai-contracts.ts';
import type { SourceColorContext } from '../src/shared/source-color-contracts.ts';
import { assertSourceColorHistory } from '../src/main/ai/source-color-validation.ts';
import { validateAiCall, validateAiResult } from '../src/main/ai/validation.ts';
import { listingFingerprint } from '../src/main/listing-ai/validation.ts';

function fixture(t:test.TestContext) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec('CREATE TABLE variants(id TEXT,product_id TEXT); CREATE TABLE assets(id TEXT,product_id TEXT,sha256 TEXT,original_path TEXT,byte_size INTEGER); CREATE TABLE image_workflow_runs(record_json TEXT); CREATE TABLE listing_drafts(id TEXT,record_json TEXT)');
  const context:SourceColorContext={policyVersion:'source-color/v1',productId:randomUUID(),productRevision:3,variantId:randomUUID(),sourceSpec:'颜色分类: 602E',referenceAssets:[{assetId:randomUUID(),sha256:'a'.repeat(64)}]};
  const at='2026-10-09T01:00:00.000Z';
  const call=validateAiCall({id:randomUUID(),providerId:'deepseek',productId:context.productId,productRevision:context.productRevision,status:'SUCCEEDED',errorCode:null,requestId:null,model:'deepseek-flash',generation:1,startedAt:at,finishedAt:at,usage:{promptTokens:100,completionTokens:50,processedImages:0}});
  const observation=validateAiResult({id:randomUUID(),callId:call.id,providerId:'deepseek',productId:context.productId,productRevision:context.productRevision,variantId:context.variantId,assetId:null,assetSha256:null,sourceResultIds:[],model:'deepseek-flash',createdAt:at,reviewState:'unreviewed',sourceSha256:listingFingerprint(context),sourceColorContext:context,sourceColorRequestBytes:1000,output:{kind:'source-color',verdict:'DETERMINED',colors:['Silver','Pink'],reason:'Visible product body and decoration.',referenceAssetIds:context.referenceAssets.map(r=>r.assetId)}});
  db.prepare('INSERT INTO variants VALUES(?,?)').run(context.variantId,context.productId);
  db.prepare('INSERT INTO assets VALUES(?,?,?,?,?)').run(context.referenceAssets[0].assetId,context.productId,context.referenceAssets[0].sha256,'assets/original.png',120);
  const draft:any={id:randomUUID(),productId:context.productId,productRevision:context.productRevision,variantId:context.variantId,sku:'SKU-22',targetId:randomUUID()};
  const saveDraft=()=>{db.prepare('DELETE FROM listing_drafts WHERE id=?').run(draft.id);db.prepare('INSERT INTO listing_drafts VALUES(?,?)').run(draft.id,JSON.stringify({draft}));};saveDraft();
  const evidence:any={id:`${draft.variantId}:source-color:${observation.id}`,name:'原图可见颜色',value:'Silver, Pink',meaning:'color',source:'source_image',imageObservation:{resultId:observation.id,context:structuredClone(context),colors:['Silver','Pink']}};
  const listing:any={draftId:draft.id,draftRevision:1,productId:draft.productId,productRevision:draft.productRevision,variantId:draft.variantId,sku:draft.sku,targetId:draft.targetId,evidence:[evidence]};
  // History consumes the contexts from records already structurally validated by the backup reader.
  const consumer={...observation,id:randomUUID(),callId:randomUUID(),sourceColorContext:undefined,output:{kind:'amazon-fields',candidates:[],missing:[]},listingContext:listing} as unknown as AiResult;
  const calls=new Map<string,AiCall>([[call.id,call]]),results=new Map<string,AiResult>([[observation.id,observation],[consumer.id,consumer]]);
  return{db,context,call,observation,draft,saveDraft,evidence,listing,consumer,calls,results,check:()=>assertSourceColorHistory(db,results,calls)};
}

test('source-color calls preserve optional attempt context and validate provider, model and product identity',t=>{
  const f=fixture(t),tagged={...f.call,sourceColorContext:f.context};
  assert.deepEqual(validateAiCall(tagged),tagged);assert.deepEqual(validateAiCall(f.call),f.call);
  for(const mutation of [{providerId:'deepseek-review'},{model:'deepseek-v4-pro'},{productId:randomUUID()},{productRevision:4},{sourceColorContext:{...f.context,policyVersion:'unknown'}}])assert.throws(()=>validateAiCall({...tagged,...mutation}));
});

test('listing and image histories accept the actual determined observation without altering result indices',t=>{
  const f=fixture(t),before=structuredClone(f.consumer.sourceResultIds);
  const image={...f.consumer,id:randomUUID(),listingContext:undefined,imageContext:{listing:structuredClone(f.listing)}} as unknown as AiResult;f.results.set(image.id,image);
  assert.deepEqual(f.check(),[{relativePath:'assets/original.png',sha256:'a'.repeat(64),byteSize:120}]);
  assert.deepEqual(f.consumer.sourceResultIds,before);
});

test('listing and image evidence cannot reference a missing observation even when no source-color result remains',t=>{
  for(const placement of ['listing','image']){
    const f=fixture(t);f.results.delete(f.observation.id);
    if(placement==='image'){f.consumer.imageContext={listing:f.listing} as any;delete f.consumer.listingContext;}
    assert.throws(f.check,/来源颜色/);
  }
});

test('uncertain or conflicting observations cannot become determined downstream evidence',t=>{
  for(const verdict of ['UNCERTAIN','CONFLICTING'] as const){const f=fixture(t);f.observation.output={...f.observation.output,verdict,colors:[]} as any;assert.throws(f.check,/来源颜色/);}
});

test('downstream image colors must match the exact observation context, ordered colors, ID and display value',t=>{
  const mutations:((f:ReturnType<typeof fixture>)=>void)[]=[
    f=>{f.evidence.imageObservation.resultId=randomUUID();},
    f=>{f.evidence.imageObservation.context.sourceSpec='602Q';},
    f=>{f.evidence.imageObservation.context.referenceAssets[0].sha256='b'.repeat(64);},
    f=>{f.evidence.imageObservation.colors=['Pink','Silver'];f.evidence.value='Pink, Silver';},
    f=>{f.evidence.value='Gold';},f=>{f.evidence.id=`${randomUUID()}:source-color:${f.observation.id}`;},
    f=>{f.evidence.meaning='material';},f=>{delete f.evidence.imageObservation;},
  ];
  for(const mutate of mutations){const f=fixture(t);mutate(f);assert.throws(f.check,/来源颜色/);}
});

test('source-image provenance cannot masquerade as source-confirmed, human-confirmed or selected-SKU evidence',t=>{
  for(const source of ['source_confirmed','human_confirmed','selected_sku'])for(const keepMetadata of [true,false]){
    const f=fixture(t);f.evidence.source=source;if(!keepMetadata)delete f.evidence.imageObservation;
    assert.throws(f.check,/来源颜色/);
  }
});

test('an observation from another product or source revision cannot support a listing snapshot',t=>{
  for(const mutation of [{productId:randomUUID()},{productRevision:4}]){
    const f=fixture(t);Object.assign(f.listing,mutation);Object.assign(f.draft,mutation);f.saveDraft();assert.throws(f.check,/来源颜色/);
  }
});

test('a raw variant different from the listing anchor requires actual draft sales-component membership',t=>{
  const f=fixture(t),anchor=randomUUID();
  f.draft.variantId=anchor;f.listing.variantId=anchor;f.evidence.id=`${anchor}:source-color:${f.observation.id}`;
  f.draft.salesPlan={recipe:{components:[{variantId:anchor},{variantId:f.context.variantId}]}};f.saveDraft();assert.doesNotThrow(f.check);
  f.draft.salesPlan.recipe.components=[{variantId:anchor}];f.saveDraft();assert.throws(f.check,/来源颜色/);
  delete f.draft.salesPlan;f.saveDraft();assert.throws(f.check,/来源颜色/);
});

test('image-derived evidence requires its real saved draft identity but survives later product revision changes',t=>{
  const f=fixture(t);f.draft.productRevision++;f.saveDraft();assert.doesNotThrow(f.check);
  f.draft.sku='OTHER-SKU';f.saveDraft();assert.throws(f.check,/来源颜色/);
  f.db.exec('DELETE FROM listing_drafts');assert.throws(f.check,/来源颜色/);
});

test('source-color history binds optional call context while retaining old untagged observations',t=>{
  const f=fixture(t);assert.doesNotThrow(f.check);
  (f.call as any).sourceColorContext=structuredClone(f.context);assert.doesNotThrow(f.check);
  (f.call as any).sourceColorContext.sourceSpec='602Q';assert.throws(f.check,/来源颜色/);
});

test('tagged source-color calls cannot authenticate a different result kind',t=>{
  const f=fixture(t);(f.call as any).sourceColorContext=f.context;f.results.delete(f.observation.id);delete f.consumer.listingContext;
  f.consumer.callId=f.call.id;assert.throws(f.check,/来源颜色/);
});

test('the successful source-color call remains required even for otherwise matching downstream evidence',t=>{
  const f=fixture(t);f.call.status='FAILED';f.call.errorCode='INTERRUPTED';assert.throws(f.check,/来源颜色/);
});

test('ordinary legacy records without source-image evidence need no new history tables',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());assert.deepEqual(assertSourceColorHistory(db,new Map(),new Map()),[]);
});
