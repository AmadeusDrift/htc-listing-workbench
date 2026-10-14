import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { nativeCandidateIssues, parseFullOutput, retainValidNativeCandidates } from '../src/main/listing-ai/full-schema.ts';
import { projectSourceClaims, normalizeSourceObservations, reduceSourceConsistency } from '../src/main/source-image-consistency/comparison.ts';
import { listingFingerprint } from '../src/main/json-fingerprint.ts';
import type { ListingAiContext } from '../src/shared/listing-ai-contracts.ts';
import type { SourceObservationEvidence, SourceConsistencyOutput } from '../src/shared/source-image-consistency-contracts.ts';
import { fixture } from './fixtures/listing-ai.ts';

const variantId=randomUUID(),assetId=randomUUID();
const image:SourceConsistencyOutput['assets'][number]={assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:['Red'],appearance:[],claims:[],contentPurpose:'product',observations:[{name:'color',values:['Red'],visibility:'visible'}]};
function observation(change:Partial<typeof image>={},sourceChange:Partial<SourceObservationEvidence>={}):SourceObservationEvidence {
  return {version:'source-image-consistency/v2',variantId,assessmentId:null,sourceFields:[],images:[{...structuredClone(image),...change}],conflicts:[],reasons:[],...sourceChange};
}
function context(source?:SourceObservationEvidence):ListingAiContext {
  const fullSchema={schema:{type:'object',properties:{color:{type:'string'},novel_feature:{type:'boolean'}}},metaSchema:{}};
  return {variantId,fields:[{name:'color',requirement:'required'}],evidence:[{id:variantId+':spec',name:'Selected SKU specification',meaning:'general',value:'Blue',source:'selected_sku'}],currentAttributes:{},businessValues:{},fullSchema,schemaSha256:listingFingerprint(fullSchema),sourceProduct:{selectedSku:{id:variantId},assets:[],observations:source?[source]:[]}} as unknown as ListingAiContext;
}
const candidate=()=>parseFullOutput({kind:'amazon-fields',contract:'listing-full-schema/v1',candidates:[{field:'color',nativeValue:'Red',evidenceIds:[variantId+':spec'],transformation:'translate'},{field:'novel_feature',nativeValue:true,evidenceIds:[],transformation:'infer'}],missing:[]});
const colorConflict=(c:ListingAiContext)=>nativeCandidateIssues(candidate(),c).some(issue=>issue.code==='SOURCE_VALUE_CONFLICT'&&issue.attributeNames.includes('color'));

for(const [name,change] of [
  ['low-detail',{quality:'low-detail'}],['occluded',{visibility:'occluded'}],['uncertain lighting',{lighting:'uncertain'}],
  ['alternatives',{presentation:'alternatives'}],['unknown presentation',{presentation:'unknown'}],
  ['instructions only',{contentPurpose:'instructions-only'}],['unknown content purpose',{contentPurpose:'unknown'}],
] as const)test(`${name} Red observation cannot remove the explicit Blue SKU conflict`,()=>{
  const source=observation(change),c=context(source),before=structuredClone(c);
  assert.equal(colorConflict(c),true);
  const retained=retainValidNativeCandidates(candidate(),c);
  assert.deepEqual(retained.candidates.map(field=>field.field),['novel_feature']);
  assert.ok(retained.missing.some(field=>field.field==='color'));
  assert.deepEqual(c,before,'observations and original facts remain unchanged');
});

test('clear SKU color can correct source wording, and the same visible color can be translated',()=>{
  assert.equal(colorConflict(context(observation())),false);
  const translated=observation({colors:['红色']});
  assert.equal(colorConflict(context(translated)),false);
  assert.equal(colorConflict(context(observation({contentPurpose:undefined}))),false,'old clear observations remain usable');
  assert.equal(colorConflict(context()),true);
});
test('clear general product and sibling observations cannot authorize selected SKU color',()=>{
  assert.equal(colorConflict(context(observation({}, {productReferenceAssetIds:[assetId]}))),true);
  assert.equal(colorConflict(context(observation({}, {variantId:randomUUID()}))),true);
});
test('clear observations cannot override a human-confirmed color or a program-owned value',()=>{
  const c=context(observation());c.evidence[0]={...c.evidence[0],name:'color',meaning:'color',source:'human_confirmed'};
  assert.equal(colorConflict(c),true);
  const locked=context(observation());locked.businessValues={color:'Blue'};
  assert.ok(nativeCandidateIssues(candidate(),locked).some(issue=>issue.code==='BUSINESS_VALUE_LOCKED'));
  assert.deepEqual(locked.businessValues,{color:'Blue'});
});
for(const sourceSpec of ['Blue','XZ-190'])test(`human Navy Blue remains protected with selected specification ${sourceSpec}`,()=>{
  const c=context(observation());c.evidence[0].value=sourceSpec;
  c.evidence.push({id:'manual-color',name:'color',meaning:'color',source:'human_confirmed',value:'Navy Blue'});
  const before=structuredClone(c);
  assert.equal(colorConflict(c),true,'finite vocabulary must not discard an explicit human color');
  const retained=retainValidNativeCandidates(candidate(),c);
  assert.deepEqual(retained.candidates.map(field=>field.field),['novel_feature']);
  assert.match(retained.missing.find(field=>field.field==='color')!.reason,/人工/);
  assert.deepEqual(c,before);
});
test('human color permission preserves raw names and finite translations without guessing an unfamiliar hue',()=>{
  const c=context(observation());c.evidence=[{id:'manual-color',name:'color',meaning:'color',source:'human_confirmed',value:'Navy Blue'}];
  const issues=(color:string)=>nativeCandidateIssues(parseFullOutput({kind:'amazon-fields',contract:'listing-full-schema/v1',candidates:[{field:'color',nativeValue:color}],missing:[]}),c);
  assert.equal(issues('navy blue').length,0,'exact raw name remains legal without a basic-hue guess');
  assert.ok(issues('Blue').some(issue=>issue.code==='SOURCE_VALUE_CONFLICT'),'Navy Blue must not be inferred as permission to replace it with Blue');
  assert.ok(issues('Ocean Dream').some(issue=>issue.code==='SOURCE_VALUE_CONFLICT'),'an unrecognized candidate cannot bypass protection either');
  c.evidence[0].value='蓝色';assert.equal(issues('Blue').length,0,'existing known translation stays legal');
  c.evidence[0].value='晨曦雾影';assert.equal(issues('晨曦雾影').length,0);assert.ok(issues('Red').some(issue=>issue.code==='SOURCE_VALUE_CONFLICT'));
  c.evidence[0].source='raw_source';c.evidence[0].value='unknown';assert.equal(issues('Ocean Dream').length,0,'unconfirmed unknown does not establish a new conflict');
});
test('uncertain observations retain the v2 source binding without rejecting an entire product',()=>{
  const projection=projectSourceClaims([{id:'color',name:'color',value:'Blue'}]);
  const raw={kind:'source-image-consistency',version:'source-image-consistency/v2',assets:[{...image,quality:'low-detail'}]};
  const parsed=normalizeSourceObservations(raw,{claims:projection.claims,referenceAssets:[{assetId}]} as never);
  assert.equal(reduceSourceConsistency(projection,parsed).decision,'MATCH');
  assert.deepEqual(parsed.assets[0].colors,['Red'],'reference data remains readable');
  const c=context(observation({quality:'low-detail'}));c.evidence=[];
  assert.deepEqual(retainValidNativeCandidates(candidate(),c).candidates.map(field=>field.field),['color','novel_feature'],'uncertainty alone does not invent a conflict');
});

test('listing context preserves uncertain observations as reference but does not promote them to ordinary evidence',async t=>{
  const f=await fixture(t),id=f.product.variants[0].id,original=f.ai.sourceObservationEvidence.bind(f.ai);
  let source=observation({}, {variantId:id});
  f.ai.sourceObservationEvidence=()=>source;
  const baseline=f.product,requests=f.requests.length;
  const db=(f.ai as unknown as {db:{prepare(sql:string):{all():unknown[]}}}).db;
  const history=()=>['ai_calls','ai_results','ai_usage_ledger','source_consistency_attempts','source_consistency_assessments','source_consistency_decisions'].map(table=>db.prepare(`SELECT id,record_json FROM ${table} ORDER BY id`).all());
  const savedHistory=history();
  for(const change of [{quality:'low-detail'},{visibility:'occluded'},{lighting:'uncertain'},{presentation:'alternatives'},{contentPurpose:'instructions-only'},{observations:[{name:'color',values:['Red'],visibility:'unknown'}]}] as Partial<typeof image>[]){
    source=observation(change,{variantId:id});
    const c=f.listing.currentContext(f.draft,f.product,0);
    assert.deepEqual(c.sourceProduct!.observations,[source]);
    assert.equal(c.evidence.some(evidence=>evidence.source==='image_observation'),false);
  }
  source=observation({}, {variantId:id});
  assert.equal(f.listing.currentContext(f.draft,f.product,0).evidence.some(e=>e.source==='image_observation'&&e.value==='Red'),true);
  assert.deepEqual(f.store.getProduct(f.product.id),baseline);
  assert.deepEqual(history(),savedHistory,'raw results, calls, paid usage and source assessments stay byte-for-byte intact');
  assert.deepEqual(f.amazon.getDraft(f.draft.id),f.draft,'reading context preserves manual and existing draft values');
  assert.equal(f.requests.length,requests,'reading context never sends an AI request');
  f.ai.sourceObservationEvidence=original;
});
