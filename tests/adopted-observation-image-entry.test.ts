import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture,chat } from './fixtures/listing-ai.ts';
import { ListingAiService } from '../src/main/listing-ai/service.ts';
import { nativeCandidateIssues,parseFullOutput } from '../src/main/listing-ai/full-schema.ts';
import { currentDraftEvidenceIssues } from '../src/main/listing-ai/current-evidence.ts';
import type { SourceObservationEvidence } from '../src/shared/source-image-consistency-contracts.ts';

async function adoptedFixture(t:test.TestContext){
  const f=await fixture(t),listing=new ListingAiService(f.store,f.amazon,f.ai,()=>false);
  const source:SourceObservationEvidence={version:'source-image-consistency/v2',variantId:f.draft.variantId,assessmentId:randomUUID(),sourceFields:[],images:[{assetId:f.product.assets[0].id,quality:'clear',visibility:'complete',lighting:'uncertain',presentation:'single-product',contentPurpose:'product',colors:['Red'],appearance:[],claims:[],observations:[{name:'shape',values:['rounded square'],visibility:'visible'}]}],conflicts:[],reasons:[]};
  // The source owner is replaced with already verified synthetic evidence only;
  // the real ListingAi/Ai/Amazon/SQLite services create and adopt the field result.
  f.ai.sourceObservationEvidence=()=>structuredClone(source);
  const id=`${source.variantId}:observation:${source.images[0].assetId}:0`;
  const current=listing.currentContext.bind(listing);
  // Reproduce the original saved context before the current color-authority
  // filter also started removing general observations with uncertain lighting.
  listing.currentContext=(...args)=>{const c=current(...args);c.evidence.push({id,name:'shape',value:'rounded square',meaning:'general',source:'image_observation'});return c;};
  f.respond(()=>chat({kind:'amazon-fields',contract:'listing-full-schema/v1',candidates:[{field:'item_name',nativeValue:[{value:'Rounded square coaster',marketplace_id:f.draft.marketplaceId}],evidenceIds:[id],transformation:'compose'}],missing:[]}));
  const result=await listing.suggest(f.reference);
  const draft=await listing.adopt({...f.reference,suggestionResultId:result.id,reviewResultId:null,fields:['item_name']});
  listing.currentContext=current;
  return {...f,listing,source,id,result,draft,input:{draftId:draft.id,draftRevision:draft.revision}};
}
test('adopted general observation reaches the real image-copy preparation entry without another field request',async t=>{
  const f=await adoptedFixture(t),before=JSON.stringify(f.ai.getResult(f.result.id)),requests=f.requests.length;
  const context=f.listing.currentContext(f.draft,f.product,f.amazon.executionTargetScope(f.draft.targetId).generation);
  assert.equal(context.evidence.some(e=>e.id===f.id),false,'new request context keeps the stricter projection');
  assert.ok(currentDraftEvidenceIssues(f.draft,context,id=>f.ai.getResult(id)).length,'reproduces the missing historical observation');
  const authorization=f.listing.currentAuthorizationContext(f.draft,f.product,context.targetGeneration);
  assert.deepEqual(currentDraftEvidenceIssues(f.draft,authorization,id=>f.ai.getResult(id)),[]);
  const snapshot=await f.listing.snapshotCurrentForImages(f.input);
  assert.ok(snapshot.currentListingCopy.some(copy=>copy.field==='item_name'&&copy.values.includes('Rounded square coaster')));
  assert.deepEqual(snapshot.context.fullSchema,context.fullSchema);
  assert.equal(f.requests.length,requests);assert.equal(JSON.stringify(f.ai.getResult(f.result.id)),before);
  const red=parseFullOutput({kind:'amazon-fields',contract:'listing-full-schema/v1',candidates:[{field:'color',nativeValue:[{value:'Red'}],evidenceIds:[f.id],transformation:'infer'}],missing:[]});
  assert.ok(nativeCandidateIssues(red,authorization).some(issue=>issue.code==='SOURCE_VALUE_CONFLICT'&&issue.attributeNames.includes('color')),'uncertain lighting never authorizes a color override');
});
test('changed assessment or observation cannot substitute for the adopted original citation',async t=>{
  const f=await adoptedFixture(t),assessment=f.source.assessmentId;
  f.source.assessmentId=randomUUID();await assert.rejects(f.listing.snapshotCurrentForImages(f.input),/引用不存在的来源/);
  f.source.assessmentId=assessment;f.source.images[0].observations![0].values=['different shape'];
  await assert.rejects(f.listing.snapshotCurrentForImages(f.input),/引用不存在的来源/);
  f.source.images[0].observations![0].values=['rounded square'];f.source.images[0].presentation='alternatives';
  await assert.rejects(f.listing.snapshotCurrentForImages(f.input),/引用不存在的来源/);
  assert.equal(f.requests.length,1);
});
test('an unknown original field call cannot acquire a general-observation compatibility alias',async t=>{
  const f=await adoptedFixture(t),getCall=f.ai.getCall.bind(f.ai);
  f.ai.getCall=id=>{const call=getCall(id);return call?.id===f.result.callId?{...call,status:'FAILED',errorCode:'CANCELLED'}:call;};
  await assert.rejects(f.listing.snapshotCurrentForImages(f.input),/引用不存在的来源|配置或记录格式无效/);
  assert.equal(f.requests.length,1);
});
