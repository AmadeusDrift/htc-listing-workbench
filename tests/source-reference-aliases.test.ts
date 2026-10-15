import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { normalizeSourceObservations, projectSourceClaims } from '../src/main/source-image-consistency/comparison.ts';
import { createSourceReferenceAliases, validateSourceReferenceAliases, sourceReferenceAliasesForCall } from '../src/main/source-image-consistency/reference-aliases.ts';
import { validateConsistencyContext, consistencyScopeKey, consistencyDecisionKey } from '../src/main/source-image-consistency/contracts.ts';
import { listingFingerprint } from '../src/main/json-fingerprint.ts';
import { validateAiCall, validateStoredAiResult } from '../src/main/ai/validation.ts';
import { SOURCE_REFERENCE_PROTOCOL } from '../src/shared/source-reference-alias-contracts.ts';

const context=()=>validateConsistencyContext({version:'source-image-consistency/v2',productId:randomUUID(),productRevision:1,variantId:randomUUID(),identity:{kind:'local-original'},referenceAssets:['11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111112'].map((assetId,index)=>({source:'local-original',assetId,sha256:String(index+1).repeat(64),byteSize:33,bindingEpoch:'b'.repeat(64),anchorId:null,imageId:null})),...projectSourceClaims([{id:'spec',name:'color',value:'Blue'}])});
const observation=(assetId:string)=>({assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:['Blue'],appearance:[],claims:[]});
const response=(ids:string[])=>({kind:'source-image-consistency',version:'source-image-consistency/v2',assets:ids.map(observation)});
function call(c:ReturnType<typeof context>){return {id:randomUUID(),providerId:'deepseek',productId:c.productId,productRevision:c.productRevision,status:'RUNNING',errorCode:null,requestId:null,model:'deepseek-flash',generation:1,startedAt:new Date().toISOString(),finishedAt:null,usage:{promptTokens:0,completionTokens:0,processedImages:0},sourceConsistencyContext:c,sourceReferenceProtocol:SOURCE_REFERENCE_PROTOCOL,sourceReferenceAliases:createSourceReferenceAliases(c)};}

test('short refs resolve only by the frozen complete original context, retaining literal raw and old fingerprints',()=>{
  const c=context(),map=createSourceReferenceAliases(c),raw=response(['ref_2','ref_1']),before=structuredClone(raw),hash=listingFingerprint(c),scope=consistencyScopeKey(c),decision=consistencyDecisionKey(c);
  const output=normalizeSourceObservations(raw,c,map);
  assert.deepEqual(output.assets.map(a=>a.assetId),[c.referenceAssets[1].assetId,c.referenceAssets[0].assetId]);assert.deepEqual(raw,before);
  assert.equal(listingFingerprint(c),hash);assert.equal(consistencyScopeKey(c),scope);assert.equal(consistencyDecisionKey(c),decision);
  assert.deepEqual(validateSourceReferenceAliases(map,c),map);
  for(const ids of [['ref_1','ref_1'],['ref_1','ref_3'],['ref_1'],['ref_1',c.referenceAssets[1].assetId],['ref_01','ref_2']])assert.throws(()=>normalizeSourceObservations(response(ids),c,map));
  assert.deepEqual(normalizeSourceObservations(response(c.referenceAssets.map(a=>a.assetId)),c).assets.map(a=>a.assetId),c.referenceAssets.map(a=>a.assetId));
  assert.throws(()=>normalizeSourceObservations(response([c.referenceAssets[0].assetId.slice(0,-1)+'3',c.referenceAssets[1].assetId]),c));
});

test('snapshot rejects version, context, asset hash, binding, variant, foreign, duplicate and sparse aliases',()=>{
  const c=context(),original=createSourceReferenceAliases(c);
  const mutations=[(m:any)=>m.version='source-reference-aliases/v2',(m:any)=>m.contextSha256='f'.repeat(64),(m:any)=>m.entries[0].sha256='f'.repeat(64),(m:any)=>m.entries[0].assetId=randomUUID(),(m:any)=>m.entries[1].alias='ref_1',(m:any)=>m.entries[1].alias='ref_3',(m:any)=>m.entries.reverse(),(m:any)=>m.entries.pop(),(m:any)=>m.extra=true];
  for(const mutate of mutations){const m=structuredClone(original);mutate(m);assert.throws(()=>validateSourceReferenceAliases(m,c));}
  for(const mutate of [(v:any)=>v.version='source-image-consistency/v1',(v:any)=>v.variantId=randomUUID(),(v:any)=>v.referenceAssets[0].bindingEpoch='c'.repeat(64),(v:any)=>v.referenceAssets[0].scope='product',(v:any)=>v.referenceAssets.reverse()]){const other=structuredClone(c);mutate(other);assert.throws(()=>validateSourceReferenceAliases(original,other));}
});

test('new call marker and map must survive strict roundtrip together; legacy calls stay UUID only',()=>{
  const c=context(),v=call(c);assert.deepEqual(validateAiCall(v),v);
  for(const key of ['sourceReferenceAliases','sourceReferenceProtocol']){const bad:any=structuredClone(v);delete bad[key];assert.throws(()=>validateAiCall(bad));}
  const legacy:any=structuredClone(v);delete legacy.sourceReferenceAliases;delete legacy.sourceReferenceProtocol;assert.deepEqual(validateAiCall(legacy),legacy);assert.equal(sourceReferenceAliasesForCall(legacy),undefined);
  const wrong:any=structuredClone(v);wrong.sourceConsistencyContext.variantId=randomUUID();assert.throws(()=>validateAiCall(wrong));
  const result={id:randomUUID(),callId:v.id,providerId:v.providerId,productId:c.productId,productRevision:c.productRevision,variantId:c.variantId,assetId:null,assetSha256:null,sourceResultIds:[],model:v.model,createdAt:v.startedAt,reviewState:'unreviewed',sourceSha256:listingFingerprint(c),sourceConsistencyContext:c,sourceConsistencyRequestBytes:100,output:normalizeSourceObservations(response(['ref_1','ref_2']),c,v.sourceReferenceAliases)};
  assert.deepEqual(validateStoredAiResult(result),result); // Stored canonical UUIDs never re-enter the wire parser.
});

test('alias snapshots reject same-length holes, accessor arrays and extra non-JSON properties without evaluating getters',()=>{
  const c=context(),original=createSourceReferenceAliases(c);let getters=0;
  const mutations=[(m:any)=>{delete m.entries[0];},(m:any)=>m.entries=new Array(2),(m:any)=>Object.defineProperty(m.entries,'0',{get(){getters++;return original.entries[0];},enumerable:true,configurable:true}),(m:any)=>m.entries.extra=true,(m:any)=>m.entries[Symbol('extra')]=true,(m:any)=>Object.defineProperty(m.entries,'extra',{value:true}),(m:any)=>Object.setPrototypeOf(m.entries,Object.create(Array.prototype)),(m:any)=>Object.defineProperty(m.entries[0],'alias',{get(){getters++;return 'ref_1';},enumerable:true}),(m:any)=>Object.defineProperty(m,'entries',{get(){getters++;return original.entries;},enumerable:true})];
  for(const mutate of mutations){const m=structuredClone(original);mutate(m);assert.throws(()=>validateSourceReferenceAliases(m,c));}
  assert.equal(getters,0);const persisted:any=structuredClone(original);persisted.entries[0]=null;assert.throws(()=>validateSourceReferenceAliases(persisted,c));
});
