import { confirmSourceConsistencyFixture } from './helpers/source-consistency-proof.ts';
import { sceneSet } from './fixtures/image-set.ts';
import { currentImageListingSnapshot, referenceMeasurementEvidence } from '../src/main/image-workflow/image-facts.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { importImageFiles } from '../src/main/assets.ts';
import { AmazonService } from '../src/main/amazon/service.ts';
import { HostingService } from '../src/main/hosting/service.ts';
import { AiService } from '../src/main/ai/service.ts';
import { inheritLegacyPurposeSettings } from '../src/main/ai/purpose-routing.ts';
import { ListingAiService } from '../src/main/listing-ai/service.ts';
import { assertImagePlan, assertImageTextReview, imageGenerationPrompt, imageRiskSourceSnapshot, validateProductImageContext } from '../src/main/ai/image-validation.ts';
import { validateAiResult, validateStoredAiResult } from '../src/main/ai/validation.ts';
import type { AiResult } from '../src/shared/ai-contracts.ts';
import type { CandidateImageIdentity, ImageTextReviewOutput, ProductImageContext } from '../src/shared/image-ai-contracts.ts';
import { PRODUCT_IMAGE_POLICY_VERSION } from '../src/shared/image-ai-contracts.ts';
import { openDatabase } from '../src/main/database.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { listingFingerprint } from '../src/main/listing-ai/validation.ts';
import { approvedWorkflowAsset, approvedWorkflowAssets, imageWorkflowDraftStamp, workflowRuns, validateImageWorkflowRun, validateStoredImageWorkflowRun } from '../src/main/image-workflow/records.ts';
import { ImageWorkflowService } from '../src/main/image-workflow/service.ts';
import { imageListingContextsMatch } from '../src/main/image-workflow/context-compatibility.ts';
import { ImageGenerationService } from '../src/main/image-generation/service.ts';
import { AiError } from '../src/main/ai/errors.ts';
import { saveInput, mockStorage, chat } from './fixtures/listing-ai.ts';
import { LISTING_REVIEW_OUTPUT_RULES } from '../src/main/listing-ai/review-coverage.ts';
import { assertImageWorkflowHistory } from '../src/main/image-workflow/history.ts';
import type { AiCall } from '../src/shared/ai-contracts.ts';

// Literal pre-presentation history has no new call sidecar; keep original result bytes below unchanged.
function markLiteralLegacyCall(db: ReturnType<typeof openDatabase>, result: AiResult) {
  const row=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(result.callId)!;
  const call=JSON.parse(String(row.record_json));delete call.presentationContext;delete call.purposeSnapshot;delete call.purposeAssignments;
  db.prepare('DELETE FROM ai_copy_review_upgrades WHERE id=?').run(result.callId);
  db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(call),result.callId);
}

const visualSummaryReview = JSON.parse(readFileSync(new URL('./fixtures/image-text-review-visual-summary.json', import.meta.url), 'utf8'));

const understanding = (payload: any) => ({ summary: 'A blue round coaster with a raised rim.', referenceAssetIds: payload.referenceImages.map((image: any) => image.assetId), uncertainties: ['Exact dimensions cannot be measured from the photo.'], sufficient: true });

function currentReview(payload: any) {
  return { kind: 'amazon-fields-review', verdict: 'PASS', checks: payload.candidate.candidates.flatMap((item: any) => item.items.map((value: any,index: number) => {
    const evidenceIds = payload.evidence.filter((evidence: any) => ['color','material'].includes(item.field) ? evidence.meaning === item.field : true).map((evidence: any) => evidence.id);
    return { field: item.field, index, verdict: 'SUPPORTED', evidenceIds, reason: 'Original evidence.', claims: [{ text: value.value, verdict: 'SUPPORTED', evidenceIds, reason: 'Original evidence.' }] };
  })), issues: [] };
}
async function fixture(t: test.TestContext, extraReference=false, withAge=false, legacy=false, priced=false) {
  mkdirSync(resolve('.test-data'), { recursive: true });
  const directory = mkdtempSync(resolve('.test-data/image-ai-')), store = new WorkspaceStore(directory);
  let product = store.createProduct();
  product = store.saveProduct({ ...saveInput(product), title: 'Coaster', description:'Original brand illustration on the packaging.', variants: saveInput(product).variants.map(variant => ({ ...variant, originalSpec:'库洛米 蓝色', normalizedSpec: 'Blue' })), facts: [{ id: randomUUID(), name: 'Material', value: 'Silicone', source: 'manual', sourceRef: 'fixture', state: 'human_confirmed' }, {id:randomUUID(),name:'品牌',value:'三丽鸥',source:'1688',sourceRef:'fixture',state:'source_confirmed'}] });
  if(priced)product=store.saveProduct({...saveInput(product),variants:saveInput(product).variants.map(v=>({...v,purchasePrice:'2.4'})),facts:[...product.facts,{id:randomUUID(),name:'采购币种',value:'CNY',source:'manual',sourceRef:'synthetic',state:'human_confirmed'}]});
  if(withAge)product=store.saveProduct({...saveInput(product),facts:[...product.facts,{id:randomUUID(),name:'适用年龄',value:'成人',source:'manual',sourceRef:'fixture',state:'human_confirmed'}]});
  const bytes = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes); bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12); bytes.writeUInt32BE(256, 16); bytes.writeUInt32BE(256, 20);
  const source = join(directory, 'source.png'); writeFileSync(source, bytes);
  product = await importImageFiles(store, directory, { productId: product.id, revision: product.revision }, [source], value => value);
  product = store.updateAsset({ productId: product.id, revision: product.revision, assetId: product.assets[0].id, role: 'main', variantIds: [product.variants[0].id] });
  if (extraReference) {
    const second=Buffer.from(bytes); second[32]=1; const path=join(directory,'second.png'); writeFileSync(path,second);
    product=await importImageFiles(store,directory,{productId:product.id,revision:product.revision},[path],value=>value);
    const asset=product.assets.find(asset=>asset.role!=='main')!;
    product=store.updateAsset({productId:product.id,revision:product.revision,assetId:asset.id,role:'gallery',variantIds:[product.variants[0].id]});
  }
  await confirmSourceConsistencyFixture(directory,store,product.id);
  {const db=openDatabase(directory);db.prepare('INSERT OR REPLACE INTO amazon_settings VALUES(?,?)').run('image_appearance_review_v1',JSON.stringify({enabled:false}));db.close();}
  const hosting = new HostingService(directory, store, mockStorage), amazon = new AmazonService(directory, id => store.getProduct(id), mockStorage), target = amazon.enableDemo();
  if(withAge){const getSchema=amazon.getSchema.bind(amazon);amazon.getSchema=async input=>{const schema=await getSchema(input);(schema.schema.properties as any).age_range_description={type:'array',items:{type:'object',properties:{value:{type:'string'}}}};return schema;};}
  let draft = await amazon.createDraft({ productId: product.id, variantId: product.variants[0].id, targetId: target.id, productType: 'HTC_DEMO_STORAGE_BAG', parentageLevel: 'NONE', requirements: 'LISTING', locale: 'en_US' });
  draft = amazon.saveDraft({ id: draft.id, revision: draft.revision, attributes: { item_name: [{ value: 'Blue Silicone Coaster' }], material: [{ value: 'Silicone' }], color: [{ value: 'Blue' }] } });
  if(withAge)draft=amazon.saveDraft({id:draft.id,revision:draft.revision,attributes:{...draft.attributes,age_range_description:[{value:'Adult'}]}});
  const requests: { operation: string; payload: any; body: any }[] = [];
  let respond: ((operation: string, payload: any) => Response | Promise<Response> | undefined) | undefined;
  const ai = new AiService(directory, store, hosting, mockStorage, { fetch: async (url,options) => {
    if (String(url).includes('green-cip.') || String(url).includes('.oss-cn-shanghai.')) {
      const operation = new Headers(options?.headers).get('x-acs-action') || 'ip-upload';
      const params = new URLSearchParams(Buffer.from(options!.body as Uint8Array).toString()), payload = operation === 'ImageModeration' ? JSON.parse(params.get('ServiceParameters')!) : null;
      requests.push({ operation, payload, body: null }); const custom = await respond?.(operation,payload); if (custom) return custom;
      if (operation === 'DescribeUploadToken') return new Response(JSON.stringify({ Code: 200, Data: { AccessKeyId: 'fixture-upload-id', AccessKeySecret: 'fixture-upload-secret', SecurityToken: 'fixture-upload-token', BucketName: 'oss-cip-shanghai', FileNamePrefix: 'upload/fixture/', OssInternetEndPoint: 'https://oss-cn-shanghai.aliyuncs.com', Expiration: Math.floor(Date.now()/1000)+1800 } }));
      if (operation === 'ip-upload') { assert.deepEqual(Buffer.from(options!.body as Uint8Array),bytes); return new Response(null,{status:200}); }
      if (operation === 'ImageModeration') return new Response(JSON.stringify({Code:200,RequestId:'fixture-ip-review',Data:{DataId:payload.dataId,RiskLevel:'none',Result:[{Label:'nonLabel',Description:'未检出风险'}]}}));
      throw Error('Unexpected moderation request');
    }
    const ocr = String(url).includes('ocr-api.'), body = ocr ? null : JSON.parse(String(options?.body)), content = body?.messages[1].content;
    const payload = ocr ? null : JSON.parse(Array.isArray(content) ? content[0].text : content), operation = ocr ? 'ocr' : payload.operation;
    requests.push({ operation, payload, body }); const custom = await respond?.(operation,payload); if (custom) return custom;
    if (ocr) return new Response(JSON.stringify({ Code: 'success', RequestId: 'ocr-fixture', Data: { Width: 256, Height: 256, Content: '', SubImageCount: 0, SubImages: [] } }));
    if (operation === 'listing-current-review') return chat(currentReview(payload));
    if (operation === 'image-plan') return chat({...(payload.setPolicy&&!payload.slot?{setPlan:sceneSet()}:{}), kind: 'image-plan', prompt: 'Preserve the selected SKU in supplied references on white, without added text.', textMode: 'none', expectedText: [], ipRisk:{verdict:'PASS',findings:[]}, productUnderstanding: understanding(payload) });
    if (operation === 'image-text-review') return chat({ verdict: 'PASS', checks: [], expectedTextChecks: [], noTextVerified: true, issues: [] });
    throw new Error('Unexpected provider request');
  } });
  ai.saveConnection({ id: 'deepseek', apiKey: 'image-fixture-deepseek-key' });
  ai.saveFunctionSettings({ id: 'deepseek', model: 'deepseek-flash', enabled: true }); ai.saveFunctionSettings({ id: 'deepseek-review', model: 'deepseek-v4-pro', enabled: true });
  inheritLegacyPurposeSettings((ai as any).db,'deepseek','deepseek-flash',false);inheritLegacyPurposeSettings((ai as any).db,'deepseek-review','deepseek-v4-pro',false);
  ai.importProfile({ id: 'aliyun-ocr', accessKeyId: 'image-fixture-key', accessKeySecret: 'image-fixture-secret' }); ai.setEnabled({ id: 'aliyun-ocr', enabled: true });
  ai.importProfile({ id: 'aliyun-image-risk', accessKeyId: 'image-fixture-key', accessKeySecret: 'image-fixture-secret' }); ai.setEnabled({ id: 'aliyun-image-risk', enabled: true });
  const cleanups:(()=>Promise<void>)[]=[];
  t.after(async () => { for(const cleanup of cleanups)await cleanup();await ai.close(); await hosting.close(); amazon.close(); store.close(); rmSync(directory,{ recursive:true, force:true }); });
  const listing = new ListingAiService(store, amazon, ai);
  if(legacy){const current=listing.currentContext.bind(listing);listing.currentContext=(draft,product,generation)=>current(draft,product,generation,true);}
  const reviewed = await listing.reviewCurrentForImages({ draftId: draft.id, draftRevision: draft.revision });
  const context: ProductImageContext = { listing: reviewed.context, currentListingCopy: reviewed.currentListingCopy, listingReviewResultId: reviewed.review.id, referenceAssets: product.assets.map(asset=>({assetId:asset.id,sha256:store.getAssetRecord(asset.id)!.sha256,variantId:product.variants[0].id})), purpose: 'main', policyVersion: PRODUCT_IMAGE_POLICY_VERSION,ipSource:imageRiskSourceSnapshot(product,product.variants[0].id) };
  const candidate: CandidateImageIdentity = { id: randomUUID(), sha256: createHash('sha256').update(bytes).digest('hex'), width: 256, height: 256 };
  return { directory, store, product, amazon, draft, ai, listing, context, candidate, bytes, requests, cleanup:(value:()=>Promise<void>)=>cleanups.push(value), respond: (value: typeof respond) => { respond = value; } };
}

// Historical records must contain the original limited-field context, not a v4 context with an old version stamp.
const legacyFixture=(t:test.TestContext,extraReference=false,withAge=false)=>fixture(t,extraReference,withAge,true);

test('image plan, candidate OCR and independent text review persist source-bound provenance and shared usage', async t => {
  const f = await fixture(t), fresh = () => {};
  const plan = await f.ai.imagePlan(f.context,fresh), ocr = await f.ai.recognizeGeneratedImage(f.context,f.candidate,f.bytes,fresh), review = await f.ai.reviewGeneratedImage(f.context,plan,ocr,f.candidate,fresh);
  assert.deepEqual(f.requests.map(request => request.operation), ['listing-current-review','image-plan','ocr','image-text-review']);
  assert.deepEqual(review.sourceResultIds, [f.context.listingReviewResultId,plan.id,ocr.id]);
  assert.equal(ocr.assetId,null); assert.equal(ocr.output.kind,'generated-image-ocr'); assert.equal(review.output.kind,'image-text-review');
  assert.deepEqual(validateAiResult(review),review); assert.equal(f.ai.getUsageSummary('deepseek-review').attempts,2); assert.equal(f.ai.getUsageSummary('aliyun-ocr').processedImages,1);
  assert.equal(f.store.getProduct(f.product.id).revision,f.product.revision); assert.equal(f.amazon.getDraft(f.draft.id).revision,f.draft.revision);
  assert.ok(!JSON.stringify(f.requests[1].payload).includes(f.draft.targetId));
});

test('v4 current-copy review accepts interpreted source wording without requiring claim substring coverage',async t=>{
  const f=await fixture(t,false,true),context=structuredClone(f.context.listing);
  const changedCopy=structuredClone(context);
  changedCopy.currentAttributes!.item_name=[{value:'Reworded coaster'}];
  assert.equal(imageListingContextsMatch(context,changedCopy),true);
  for(const field of ['color','material']){
    const changedFact=structuredClone(changedCopy);
    changedFact.currentAttributes![field]=[{value:'Changed actual attribute'}];
    assert.equal(imageListingContextsMatch(context,changedFact),false);
  }
  changedCopy.sourceProduct!.title='Different source product';
  assert.equal(imageListingContextsMatch(context,changedCopy),false);
  context.evidence.find(item=>item.name==='适用年龄')!.value='三岁以上';
  assert.equal(imageListingContextsMatch(f.context.listing,context),false);
  f.respond((operation,payload)=>{
    if(operation!=='listing-current-review')return undefined;
    const review=currentReview(payload);
    review.checks.forEach((check:any)=>{check.claims=[];});
    return chat(review);
  });
  const review=await f.ai.reviewCurrentListing(context,f.context.currentListingCopy,async()=>{});
  assert.equal(review.listingEvidenceContractVersion,'listing-evidence/v4');
  if(review.output.kind!=='listing-current-review')throw Error('Unexpected review');
  assert.equal(review.output.verdict,'PASS');
  assert.deepEqual(validateAiResult(review),review);
  const plan=await f.ai.imagePlan({...f.context,listing:context,listingReviewResultId:review.id},()=>{});
  assert.equal(plan.output.kind,'image-plan');
});

test('legacy PASS remains readable and current image policy permits unparsed direct source interpretation',async t=>{
  const f=await legacyFixture(t),context=structuredClone(f.context),review=structuredClone(f.ai.getResult(context.listingReviewResultId!)!);
  const evidence={id:randomUUID(),name:'适用年龄',value:'三岁以上',meaning:'general' as const,source:'source_confirmed' as const};
  context.listing.fields=[{name:'age_range_description',title:'Age',requirement:'required',closedEnum:false,allowedValues:[],suggestedValues:[]}];
  context.listing.evidence=[evidence];context.currentListingCopy=[{field:'age_range_description',values:['Adult']}];
  review.listingContext=context.listing;review.sourceSha256=listingFingerprint(context.listing);delete review.listingEvidenceContractVersion;
  review.output={kind:'listing-current-review',verdict:'PASS',currentListingCopy:context.currentListingCopy,copySha256:listingFingerprint(context.currentListingCopy),checks:[{field:'age_range_description',index:0,verdict:'SUPPORTED',evidenceIds:[evidence.id],reason:'Legacy source interpretation.',claims:[{text:'Adult',verdict:'SUPPORTED',evidenceIds:[evidence.id],reason:'Legacy source interpretation.'}]}],issues:[]};
  const db=openDatabase(f.directory);try{markLiteralLegacyCall(db,review);db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify(review),review.id);}finally{db.close();}
  assert.deepEqual(f.ai.getResult(review.id),review);
  const before=f.requests.length,plan=await f.ai.imagePlan(context,()=>{});assert.equal(plan.output.kind,'image-plan');assert.equal(plan.listingEvidenceContractVersion,'listing-evidence/v5');assert.equal(f.requests.length,before+1);assert.deepEqual(f.ai.getResult(review.id),review);
});

function withoutCopyReview(context: ProductImageContext): ProductImageContext {
  return { ...context, listingReviewResultId: null, copyReviewBypass: { policy: 'copy-review-disabled/v1', at: '2026-10-09T00:00:00.000Z', contextSha256: listingFingerprint(context.listing), copySha256: listingFingerprint(context.currentListingCopy) } };
}

function productionWorkflow(f:Awaited<ReturnType<typeof fixture>>,failAfter?:number){
  let posts=0;
  f.respond(operation=>operation==='ip-upload'?new Response(null,{status:200}):undefined);
  const generation=new ImageGenerationService(f.directory,f.store,mockStorage,{decodePreview:bytes=>bytes,fetch:async()=>{
    posts++;if(failAfter!==undefined&&posts>failAfter)throw new Error('Fixture lost generation response');
    const bytes=Buffer.from(f.bytes);bytes[32]=posts;return Response.json({data:[{b64_json:bytes.toString('base64')}]});
  }});
  generation.saveConnection({model:'openai/gpt-image-2.5-sunburst',enabled:true,apiKey:'test-only'});
  const workflow=new ImageWorkflowService(f.directory,f.store,f.amazon,f.ai,generation);
  if(!f.context.listing.contract){const listing=(workflow as any).listing as ListingAiService,current=listing.currentContext.bind(listing);listing.currentContext=(draft,product,generation)=>current(draft,product,generation,true);}
  f.cleanup(async()=>{await workflow.close();await generation.close();});
  return {workflow,posts:()=>posts};
}

for(const version of [undefined,'listing-evidence/v1','listing-evidence/v2'] as const)for(const proof of ['caption','adoption'] as const)
test((version??'v0')+' old-builder '+proof+' keeps history immutable while current execution permits matching source interpretation',async t=>{
  const f=await legacyFixture(t,false,true),{workflow,posts}=productionWorkflow(f);
  const legacy=(workflow as any).listing as ListingAiService,strict=legacy.currentContext.bind(legacy);
  const omitAge=(context:ReturnType<ListingAiService['currentContext']>)=>({...context,evidence:context.evidence.filter(item=>item.name!=='适用年龄')});
  legacy.currentContext=(...args)=>omitAge(strict(...args));
  legacy.complete=async()=>({draft:f.amazon.getDraft(f.draft.id),aiCalls:0,previewAttempts:0,remaining:[]});
  let draft=f.draft;
  if(proof==='adoption'){
    const original=f.listing.currentContext.bind(f.listing);
    f.listing.currentContext=(...args)=>omitAge(original(...args));
    f.respond((operation,payload)=>{
      if(operation==='ip-upload')return new Response(null,{status:200});
      if(!operation&&payload.fields)return chat(payload.candidate?currentReview(payload):{kind:'amazon-fields',candidates:[{field:'item_name',items:[{value:'Adult Coaster',evidenceIds:payload.evidence.filter((e:any)=>e.meaning==='material').map((e:any)=>e.id),transformation:'compose'}]}],missing:payload.fields.filter((field:any)=>field.name!=='item_name').map((field:any)=>({field:field.name,reason:'Not requested here'}))});
    });
    const suggestion=await f.listing.suggest({draftId:draft.id,draftRevision:draft.revision}),review=await f.listing.review({draftId:draft.id,draftRevision:draft.revision,suggestionResultId:suggestion.id});
    draft=await f.listing.adopt({draftId:draft.id,draftRevision:draft.revision,suggestionResultId:suggestion.id,reviewResultId:review.id,fields:['item_name']});
    f.listing.currentContext=original;
  }
  const material=f.context.listing.evidence.find(e=>e.meaning==='material')!,set=sceneSet();
  if(proof==='caption')set.slots[1]={...set.slots[1],role:'selling_point',focus:'Adult use',evidenceIds:[material.id],textMode:'planned',expectedText:[{text:'Adult Coaster',evidenceIds:[material.id]}]};
  f.respond((operation,payload)=>{
    if(operation==='ip-upload')return new Response(null,{status:200});
    if(operation==='image-plan')return chat({...(payload.setPolicy&&!payload.slot?{setPlan:set}:{}),kind:'image-plan',prompt:'Preserve the selected SKU.',textMode:proof==='caption'&&payload.slot?.index===2?'planned':'none',expectedText:proof==='caption'&&payload.slot?.index===2?set.slots[1].expectedText:[],ipRisk:{verdict:'PASS',findings:[]},productUnderstanding:understanding(payload)});
  });
  const first=await workflow.complete({draftId:draft.id,draftRevision:draft.revision});
  assert.equal(first.workflow.status,'COMPLETED',first.workflow.error??'');assert.equal(posts(),7);
  legacy.currentContext=strict;
  const prior=structuredClone(first.workflow);
  if(version)prior.listingEvidenceContractVersion=version;else delete prior.listingEvidenceContractVersion;
  const db=openDatabase(f.directory),saved=new Map<string,string>();
  try{
    for(const row of db.prepare('SELECT id,record_json FROM ai_results').all()){
      const record=JSON.parse(String(row.record_json));
      if(record.listingContext||record.imageContext){if(version)record.listingEvidenceContractVersion=version;else delete record.listingEvidenceContractVersion;}
      const raw=JSON.stringify(record);saved.set(String(row.id),raw);db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(raw,row.id);
    }
    const raw=JSON.stringify(prior);db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(raw,prior.id);
    assert.deepEqual(f.ai.getResult(prior.setPlanResultId!),JSON.parse(saved.get(prior.setPlanResultId!)!));
    assert.equal(approvedWorkflowAssets(db,first.draft,f.store.getProduct(f.product.id))?.length,7);
    const before=f.requests.length;
    await assert.rejects(workflow.recheck({draftId:draft.id,draftRevision:first.draft.revision,sourceWorkflowId:prior.id}));
    await assert.rejects(async()=>workflow.complete({draftId:draft.id,draftRevision:first.draft.revision}));
    assert.equal(f.requests.length,before);assert.equal(posts(),7);
    assert.equal(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(prior.id)!.record_json,raw);
    const interrupted=JSON.stringify({...prior,status:'INTERRUPTED',error:'Historical interrupted fixture'});
    db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(interrupted,prior.id);
    await assert.rejects(async()=>workflow.complete({draftId:draft.id,draftRevision:first.draft.revision}));
    assert.equal(f.requests.length,before);assert.equal(posts(),7);
    assert.equal(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(prior.id)!.record_json,interrupted);
    for(const [id,bytes] of saved)assert.equal(db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(id)!.record_json,bytes);
  }finally{db.close();}
});

test('same-value prose citation repair permits rechecking seven valid legacy images without regeneration',async t=>{
  const f=await legacyFixture(t,false,true);
  const respondFields=(operation:string,payload:any)=>{
    if(operation==='ip-upload')return new Response(null,{status:200});
    if(!operation&&payload.fields)return chat(payload.candidate?currentReview(payload):{kind:'amazon-fields',candidates:[{field:'item_name',items:[{value:'Adult Coaster',evidenceIds:payload.evidence.filter((e:any)=>e.name==='适用年龄').map((e:any)=>e.id),transformation:'compose'}]}],missing:payload.fields.filter((field:any)=>field.name!=='item_name').map((field:any)=>({field:field.name,reason:'Outside this repair'}))});
  };
  f.respond(respondFields);
  const input={draftId:f.draft.id,draftRevision:f.draft.revision},suggestion=await f.listing.suggest(input),review=await f.listing.review({...input,suggestionResultId:suggestion.id});
  let draft=await f.listing.adopt({...input,suggestionResultId:suggestion.id,reviewResultId:review.id,fields:['item_name']});
  const market=draft.marketplaceId;
  draft=f.amazon.saveDraft({id:draft.id,revision:draft.revision,attributes:{...draft.attributes,material:[{value:'Silicone',marketplace_id:market}],color:[{value:'Blue',marketplace_id:market}],brand:[{value:'Generic',marketplace_id:market}],purchasable_offer:[{marketplace_id:market,currency:'USD',audience:'ALL',our_price:[{schedule:[{value_with_tax:10}]}]}]}});
  const {workflow,posts}=productionWorkflow(f),age=f.context.listing.evidence.find(e=>e.name==='适用年龄')!,set=sceneSet();
  f.amazon.previewDraft=async()=>({...f.amazon.getDraft(draft.id),state:'AMAZON_VALIDATED',previewIssues:[]});
  set.slots[1]={...set.slots[1],role:'selling_point',focus:'Adult use',evidenceIds:[age.id],textMode:'planned',expectedText:[{text:'Adult Coaster',evidenceIds:[age.id]}]};
  f.respond((operation,payload)=>{
    if(operation==='image-plan')return chat({...(payload.setPolicy&&!payload.slot?{setPlan:set}:{}),kind:'image-plan',prompt:'Preserve the selected SKU.',textMode:payload.slot?.index===2?'planned':'none',expectedText:payload.slot?.index===2?set.slots[1].expectedText:[],ipRisk:{verdict:'PASS',findings:[]},productUnderstanding:understanding(payload)});
    return respondFields(operation,payload);
  });
  const first=await workflow.complete({draftId:draft.id,draftRevision:draft.revision});
  assert.equal(first.workflow.status,'COMPLETED',first.workflow.error??'');assert.equal(posts(),7);
  const material=suggestion.listingContext!.evidence.find(e=>e.meaning==='material')!,oldSuggestion=structuredClone(suggestion),oldReview=structuredClone(review);
  if(oldSuggestion.output.kind!=='amazon-fields'||oldReview.output.kind!=='amazon-fields-review')throw Error('fixture kind');
  oldSuggestion.output.candidates[0].items[0].evidenceIds=[material.id];
  oldReview.output.checks[0].evidenceIds=[material.id];oldReview.output.checks[0].claims[0].evidenceIds=[material.id];
  const db=openDatabase(f.directory),oldRun={...first.workflow,listingEvidenceContractVersion:'listing-evidence/v2' as const};
  try{
    const saved=new Map<string,string>();
    for(const row of db.prepare('SELECT id,record_json FROM ai_results').all()){
      const result=row.id===suggestion.id?oldSuggestion:row.id===review.id?oldReview:JSON.parse(String(row.record_json));
      if(result.listingContext||result.imageContext)result.listingEvidenceContractVersion='listing-evidence/v2';
      const raw=JSON.stringify(result);saved.set(String(row.id),raw);db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(raw,row.id);
    }
    const record=JSON.parse(String(db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(draft.id)!.record_json));
    record.draft.fieldAdoptions[0].changes[0].evidence=[material];draft=record.draft;
    db.prepare('UPDATE listing_drafts SET record_json=? WHERE id=?').run(JSON.stringify(record),draft.id);
    const oldBytes=JSON.stringify(oldRun);db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(oldBytes,oldRun.id);
    assert.equal(approvedWorkflowAssets(db,draft,f.store.getProduct(f.product.id))?.length,7);
    const before=f.requests.length;f.amazon.previewDraft=async()=>({...f.amazon.getDraft(draft.id),state:'AMAZON_VALIDATED',previewIssues:[]});
    const repaired=await f.listing.complete({draftId:draft.id,draftRevision:draft.revision});
    assert.equal(repaired.aiCalls,2);assert.equal(f.requests.length,before+2);assert.deepEqual(repaired.remaining,[]);
    assert.deepEqual(repaired.draft.attributes,draft.attributes);assert.equal(repaired.draft.fieldAdoptions!.length,draft.fieldAdoptions!.length+1);
    const rechecked=await workflow.recheck({draftId:draft.id,draftRevision:repaired.draft.revision,sourceWorkflowId:oldRun.id});
    assert.equal(rechecked.workflow.status,'COMPLETED',rechecked.workflow.error??'');assert.equal(posts(),7);
    assert.deepEqual(rechecked.workflow.slots!.map(slot=>slot.approvedAssetId),oldRun.slots!.map(slot=>slot.approvedAssetId));
    assert.equal(approvedWorkflowAssets(db,rechecked.draft,f.store.getProduct(f.product.id))?.length,7);
    const calls=f.requests.length,repeated=await workflow.recheck({draftId:draft.id,draftRevision:rechecked.draft.revision,sourceWorkflowId:oldRun.id});
    assert.equal(repeated.aiCalls,0);assert.equal(f.requests.length,calls);assert.equal(posts(),7);
    assert.equal(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(oldRun.id)!.record_json,oldBytes);
    for(const [id,raw] of saved)assert.equal(db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(id)!.record_json,raw);
  }finally{db.close();}
});

test('a cached legacy PASS with exact context and copy hashes cannot bypass current source parsing',async t=>{
  const f=await legacyFixture(t,false,true),review=structuredClone(f.ai.getResult(f.context.listingReviewResultId!)!);
  const evidence=review.listingContext!.evidence.find(e=>e.name==='适用年龄')!;
  evidence.value='三岁以上';review.sourceSha256=listingFingerprint(review.listingContext);delete review.listingEvidenceContractVersion;
  const db=openDatabase(f.directory);try{
    db.prepare('UPDATE facts SET value=? WHERE id=?').run(evidence.value,evidence.id);
    markLiteralLegacyCall(db,review);
    db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify(review),review.id);
  }finally{db.close();}
  const draft=f.amazon.getDraft(f.draft.id),snapshot=currentImageListingSnapshot(draft,f.listing.currentContext(draft,f.store.getProduct(f.product.id),f.amazon.executionTargetScope(draft.targetId).generation));
  assert.equal(listingFingerprint(snapshot.context),review.sourceSha256);assert.deepEqual(f.ai.getResult(review.id),review);
  const {workflow,posts}=productionWorkflow(f),before=f.requests.length,result=await workflow.complete({draftId:draft.id,draftRevision:draft.revision});
  assert.notEqual(result.workflow.status,'COMPLETED');assert.equal(f.requests.length,before);assert.equal(posts(),0);assert.equal(result.workflow.imageContext,undefined);
});

test('legacy caption and nested set-plan evidence remains readable and backup-stable but cannot authorize continuation',async t=>{
  const f=await legacyFixture(t),context:ProductImageContext={...structuredClone(f.context),setPolicy:'seven-product-v2',referenceMeasurements:[]};
  const saved=await f.ai.imagePlan(context,()=>{}),review=structuredClone(f.ai.getResult(context.listingReviewResultId!)!);
  const evidence={id:context.listing.variantId+':audience',name:'适用对象',value:'儿童',meaning:'general' as const,source:'selected_sku' as const};
  context.listing.evidence.push(evidence);
  review.listingContext=context.listing;review.sourceSha256=listingFingerprint(context.listing);delete review.listingEvidenceContractVersion;
  const plan=structuredClone(saved);plan.imageContext=context;plan.sourceSha256=listingFingerprint(context);delete plan.listingEvidenceContractVersion;
  assert.equal(plan.output.kind,'image-plan');if(plan.output.kind!=='image-plan')throw Error('plan');
  const set=plan.output.setPlan!;set.slots[1].textMode='planned';set.slots[1].evidenceIds=[evidence.id];set.slots[1].expectedText=[{text:'Adult Coaster',evidenceIds:[evidence.id]}];
  const planOutput=plan.output;assert.throws(()=>assertImagePlan(planOutput,context));
  assert.deepEqual(validateStoredAiResult(plan),plan);
  assert.throws(()=>validateStoredAiResult({...plan,listingEvidenceContractVersion:'listing-evidence/v1'}));
  const slotContext=validateProductImageContext({...context,purpose:'detail',slot:{index:2,total:7,provisional:true},setPlan:set},{storedVersion:null});
  const nested={...structuredClone(plan),id:randomUUID(),imageContext:slotContext,sourceSha256:listingFingerprint(slotContext),output:{...plan.output,setPlan:undefined,textMode:'planned',expectedText:set.slots[1].expectedText}};
  delete nested.output.setPlan;
  assert.equal(listingFingerprint(validateProductImageContext(slotContext,{storedVersion:null})),nested.sourceSha256);
  assert.deepEqual(validateStoredAiResult(nested),nested);assert.throws(()=>validateAiResult(nested));
  const at=new Date().toISOString(),run={id:randomUUID(),draftId:f.draft.id,productId:f.product.id,productRevision:f.product.revision,variantId:f.draft.variantId,sku:f.draft.sku,status:'BLOCKED',stage:'planning',attempt:0,maxAttempts:3,contextSha256:listingFingerprint(context),draftSha256:imageWorkflowDraftStamp(f.draft),referenceAssets:context.referenceAssets.map(ref=>({id:ref.assetId,sha256:ref.sha256})),planResultIds:[],candidateIds:[],ocrResultIds:[],reviewResultIds:[],ipReviewResultIds:[],approvedAssetId:null,approvedSha256:null,createdAt:at,updatedAt:at,error:'Historical blocked plan',imagePolicyVersion:PRODUCT_IMAGE_POLICY_VERSION,slotPolicy:'seven-product-v2',imageContext:context,setPlan:set,setPlanResultId:plan.id,slots:Array.from({length:7},(_,i)=>({index:i+1,purpose:i===0?'main':'detail',status:'PENDING',contextSha256:null,attempts:[],approvedAssetId:null,approvedSha256:null,error:null}))};
  const rawPlan=JSON.stringify(plan),rawRun=JSON.stringify(run),db=openDatabase(f.directory);try{
    markLiteralLegacyCall(db,review);
    db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify(review),review.id);
    markLiteralLegacyCall(db,plan);
    db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(rawPlan,plan.id);
    db.prepare('INSERT INTO image_workflow_runs VALUES (?,?)').run(run.id,rawRun);
    assert.equal(workflowRuns(db)[0].contextSha256,run.contextSha256);
  }finally{db.close();}
  const backup=join(f.directory,'legacy-caption.htcbackup'),target=join(f.directory,'legacy-caption-restored');
  await createWorkspaceBackup(f.directory,backup,'historical caption evidence passphrase');await commitWorkspaceRestore(target,await prepareWorkspaceRestore(target,backup,'historical caption evidence passphrase'));
  const restored=openDatabase(target);try{assert.equal(restored.prepare('SELECT record_json FROM ai_results WHERE id=?').get(plan.id)!.record_json,rawPlan);assert.equal(restored.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(run.id)!.record_json,rawRun);}finally{restored.close();}
  const {workflow,posts}=productionWorkflow(f),before=f.requests.length;
  await assert.rejects(async()=>workflow.complete({draftId:f.draft.id,draftRevision:f.draft.revision}));assert.equal(f.requests.length,before);assert.equal(posts(),0);
});

for(const version of [undefined,'listing-evidence/v1','listing-evidence/v2'] as const)test(`${version??'v0'} negative-caption history preserves nested plans, run literals and backup bytes`,async t=>{
  const f=await legacyFixture(t),context:ProductImageContext={...structuredClone(f.context),setPolicy:'seven-product-v2',referenceMeasurements:[]};
  const saved=await f.ai.imagePlan(context,()=>{}),review=structuredClone(f.ai.getResult(context.listingReviewResultId!)!);
  const evidence={id:context.listing.variantId+':age',name:'适用年龄',value:version==='listing-evidence/v2'?'儿童':'不适合儿童',meaning:'general' as const,source:'selected_sku' as const};
  context.listing.evidence.push(evidence);
  review.listingContext=context.listing;review.sourceSha256=listingFingerprint(context.listing);
  if(version)review.listingEvidenceContractVersion=version;else delete review.listingEvidenceContractVersion;
  const plan=structuredClone(saved);plan.imageContext=context;plan.sourceSha256=listingFingerprint(context);
  if(version)plan.listingEvidenceContractVersion=version;else delete plan.listingEvidenceContractVersion;
  if(plan.output.kind!=='image-plan')throw Error('plan');
  const set=plan.output.setPlan!;set.slots[1].textMode='planned';set.slots[1].evidenceIds=[evidence.id];set.slots[1].expectedText=[{text:'Child Coaster',evidenceIds:[evidence.id]}];
  assert.deepEqual(validateStoredAiResult(plan),plan);assert.deepEqual(validateStoredAiResult(review),review);
  if(version==='listing-evidence/v2')assert.doesNotThrow(()=>validateAiResult(plan));else assert.throws(()=>validateAiResult(plan));
  const slotContext=validateProductImageContext({...context,purpose:'detail',slot:{index:2,total:7,provisional:true},setPlan:set},{storedVersion:version??null});
  const nested={...structuredClone(plan),id:randomUUID(),imageContext:slotContext,sourceSha256:listingFingerprint(slotContext),output:{...plan.output,textMode:'planned',expectedText:set.slots[1].expectedText}};
  delete nested.output.setPlan;
  assert.deepEqual(validateStoredAiResult(nested),nested);
  const negative=structuredClone(nested);negative.imageContext.listing.evidence.find(e=>e.id===evidence.id)!.value='不适合儿童';negative.sourceSha256=listingFingerprint(negative.imageContext);
  for(const marker of [undefined,'listing-evidence/v1','listing-evidence/v2'] as const){
    if(marker)negative.listingEvidenceContractVersion=marker;else delete negative.listingEvidenceContractVersion;
    assert.throws(()=>validateAiResult(negative));
    if(marker==='listing-evidence/v2')assert.throws(()=>validateStoredAiResult(negative));else assert.doesNotThrow(()=>validateStoredAiResult(negative));
  }
  const at=new Date().toISOString(),run={...(version?{listingEvidenceContractVersion:version}:{}),id:randomUUID(),draftId:f.draft.id,productId:f.product.id,productRevision:f.product.revision,variantId:f.draft.variantId,sku:f.draft.sku,status:'BLOCKED',stage:'planning',attempt:0,maxAttempts:3,contextSha256:listingFingerprint(context),draftSha256:imageWorkflowDraftStamp(f.draft),referenceAssets:context.referenceAssets.map(ref=>({id:ref.assetId,sha256:ref.sha256})),planResultIds:[],candidateIds:[],ocrResultIds:[],reviewResultIds:[],ipReviewResultIds:[],approvedAssetId:null,approvedSha256:null,createdAt:at,updatedAt:at,error:'Historical negative-caption plan',imagePolicyVersion:PRODUCT_IMAGE_POLICY_VERSION,slotPolicy:'seven-product-v2',imageContext:context,setPlan:set,setPlanResultId:plan.id,slots:Array.from({length:7},(_,i)=>({index:i+1,purpose:i===0?'main':'detail',status:'PENDING',contextSha256:null,attempts:[],approvedAssetId:null,approvedSha256:null,error:null}))};
  assert.deepEqual(validateStoredImageWorkflowRun(run),run);
  if(version==='listing-evidence/v2')assert.doesNotThrow(()=>validateImageWorkflowRun(run));else assert.throws(()=>validateImageWorkflowRun(run));
  const rawPlan=JSON.stringify(plan),rawRun=JSON.stringify(run),rawReview=JSON.stringify(review),db=openDatabase(f.directory);try{
    markLiteralLegacyCall(db,review);
    db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(rawReview,review.id);
    markLiteralLegacyCall(db,plan);
    db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(rawPlan,plan.id);
    db.prepare('INSERT INTO image_workflow_runs VALUES (?,?)').run(run.id,rawRun);
    assert.deepEqual(workflowRuns(db)[0],run);
  }finally{db.close();}
  assert.deepEqual(f.ai.getResult(plan.id),plan);assert.ok(f.ai.listResults(f.product.id).some(result=>result.id===plan.id));
  const backup=join(f.directory,'versioned-caption.htcbackup'),target=join(f.directory,'versioned-caption-restored');
  await createWorkspaceBackup(f.directory,backup,'versioned caption passphrase');await commitWorkspaceRestore(target,await prepareWorkspaceRestore(target,backup,'versioned caption passphrase'));
  const restored=openDatabase(target);try{
    assert.equal(restored.prepare('SELECT record_json FROM ai_results WHERE id=?').get(plan.id)!.record_json,rawPlan);
    assert.equal(restored.prepare('SELECT record_json FROM ai_results WHERE id=?').get(review.id)!.record_json,rawReview);
    assert.equal(restored.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(run.id)!.record_json,rawRun);
  }finally{restored.close();}
  if(version!=='listing-evidence/v2'){
    const {workflow,posts}=productionWorkflow(f),before=f.requests.length;
    await assert.rejects(async()=>workflow.complete({draftId:f.draft.id,draftRevision:f.draft.revision}));assert.equal(f.requests.length,before);assert.equal(posts(),0);
  }
});

for(const version of [undefined,'listing-evidence/v1'] as const)test(`${version??'v0'} PASS review of an excluded category remains readable but authorizes no image calls`,async t=>{
  const f=await legacyFixture(t),context=structuredClone(f.context),review=structuredClone(f.ai.getResult(context.listingReviewResultId!)!);
  const evidence={id:randomUUID(),name:'适用年龄',value:'不适合儿童',meaning:'general' as const,source:'source_confirmed' as const};
  context.listing.fields=[{name:'age_range_description',title:'Age',requirement:'required',closedEnum:false,allowedValues:[],suggestedValues:[]}];
  context.listing.evidence=[evidence];context.currentListingCopy=[{field:'age_range_description',values:['Child']}];
  review.listingContext=context.listing;review.sourceSha256=listingFingerprint(context.listing);
  if(version)review.listingEvidenceContractVersion=version;else delete review.listingEvidenceContractVersion;
  review.output={kind:'listing-current-review',verdict:'PASS',currentListingCopy:context.currentListingCopy,copySha256:listingFingerprint(context.currentListingCopy),checks:[{field:'age_range_description',index:0,verdict:'SUPPORTED',evidenceIds:[evidence.id],reason:'Historical keyword match.',claims:[{text:'Child',verdict:'SUPPORTED',evidenceIds:[evidence.id],reason:'Historical keyword match.'}]}],issues:[]};
  const db=openDatabase(f.directory);try{markLiteralLegacyCall(db,review);db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify(review),review.id);}finally{db.close();}
  assert.deepEqual(f.ai.getResult(review.id),review);assert.throws(()=>validateAiResult(review));assert.throws(()=>validateStoredAiResult({...review,listingEvidenceContractVersion:'listing-evidence/v2'}));
  const before=f.requests.length;await assert.rejects(f.ai.imagePlan(context,()=>{}));assert.equal(f.requests.length,before);
});

for(const version of [undefined,'listing-evidence/v1','listing-evidence/v2'] as const)for(const resumeEmpty of [false,true])test(`a ${resumeEmpty?'resumed empty':'fresh'} ${version??'unmarked'} recheck versions its new context without rewriting old paid evidence`,async t=>{
  const f=await legacyFixture(t),{workflow,posts}=productionWorkflow(f),material=f.context.listing.evidence.find(e=>e.meaning==='material')!;
  const sourceDb=openDatabase(f.directory);
  try{sourceDb.prepare('INSERT INTO facts VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),f.product.id,'适用年龄','成人','manual','upgrade-era omitted conflict','conflicting',99);}finally{sourceDb.close();}
  // Recreate only the historical builder omission; source/IP facts stay identical.
  const legacyListing=(workflow as any).listing as ListingAiService,strictContext=legacyListing.currentContext.bind(legacyListing);
  legacyListing.currentContext=(...args)=>{const context=strictContext(...args);delete context.evidenceBlockers;return context;};
  const set=sceneSet();set.slots[1]={...set.slots[1],role:'selling_point',focus:'Silicone material',evidenceIds:[material.id],textMode:'planned',expectedText:[{text:'Silicone Coaster',evidenceIds:[material.id]}]};
  f.respond((operation,payload)=>{
    if(operation==='ip-upload')return new Response(null,{status:200});
    if(operation==='image-plan')return chat({...(payload.setPolicy&&!payload.slot?{setPlan:set}:{}),kind:'image-plan',prompt:'Preserve the selected SKU in supplied references on white.',textMode:payload.slot?.index===2?'planned':'none',expectedText:payload.slot?.index===2?set.slots[1].expectedText:[],ipRisk:{verdict:'PASS',findings:[]},productUnderstanding:understanding(payload)});
  });
  const first=await workflow.complete({draftId:f.draft.id,draftRevision:f.draft.revision});
  assert.equal(first.workflow.status,'COMPLETED',first.workflow.error??'');assert.equal(posts(),7);
  assert.equal(first.workflow.listingEvidenceContractVersion,'listing-evidence/v5');
  const prior=structuredClone(first.workflow);if(version)prior.listingEvidenceContractVersion=version;else delete prior.listingEvidenceContractVersion;
  const oldRun=JSON.stringify(prior),oldResults=new Map<string,string>(),db=openDatabase(f.directory);
  try{
    for(const row of db.prepare('SELECT id,record_json FROM ai_results').all()){
      const value=JSON.parse(String(row.record_json));if(version&&(value.listingContext||value.imageContext))value.listingEvidenceContractVersion=version;else delete value.listingEvidenceContractVersion;
      const raw=JSON.stringify(value);oldResults.set(String(row.id),raw);db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(raw,row.id);
    }
    db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(oldRun,prior.id);
    const input={draftId:f.draft.id,draftRevision:first.draft.revision,sourceWorkflowId:prior.id},beforeReuse=f.requests.length;
    const reused=await workflow.recheck(input);
    assert.equal(reused.workflow.approvalReuse?.sourceRunId,prior.id);assert.equal(reused.workflow.listingEvidenceContractVersion,version);
    assert.equal(f.requests.length,beforeReuse);assert.equal(reused.workflow.contextSha256,prior.contextSha256);
    legacyListing.currentContext=strictContext;
    assert.deepEqual(prior.imageContext?.ipSource,imageRiskSourceSnapshot(f.store.getProduct(f.product.id),prior.variantId));
    let pendingId:string|undefined;
    if(resumeEmpty){
      const now=new Date(Date.now()+1).toISOString(),pending={...structuredClone(prior),id:randomUUID(),status:'INTERRUPTED' as const,stage:'content' as const,attempt:0,maxAttempts:1,contextSha256:null,draftSha256:null,referenceAssets:[],planResultIds:[],candidateIds:[],ipReviewResultIds:[],ocrResultIds:[],reviewResultIds:[],approvedAssetId:null,approvedSha256:null,createdAt:now,updatedAt:now,error:'Interrupted before current context',recheckedFromRunId:prior.id};
      pending.slots=pending.slots!.map(slot=>({...slot,status:'PENDING',contextSha256:null,attempts:[],approvedAssetId:null,approvedSha256:null,error:null}));
      delete pending.imageContext;delete pending.activeSlot;delete pending.copyRepairAttempts;delete pending.approvalReuse;delete pending.contentPreparation;delete pending.copyReviewResultId;delete pending.categoryFieldRepair;
      db.prepare('INSERT INTO image_workflow_runs VALUES (?,?)').run(pending.id,JSON.stringify(pending));pendingId=pending.id;
    }
    const beforeCancel=f.requests.length;
    const starting=(workflow as any).recheckWithFreshEvidence(input);
    const created=workflow.getProgress(f.draft.id)!;
    workflow.cancel(f.draft.id);const cancelled=await starting;
    assert.equal(created.imageContext,undefined);assert.equal(created.status,'RUNNING');
    assert.equal(created.listingEvidenceContractVersion,'listing-evidence/v5');
    assert.equal(cancelled.workflow.status,'CANCELLED');assert.equal(cancelled.workflow.listingEvidenceContractVersion,'listing-evidence/v5');
    assert.equal(f.requests.length,beforeCancel);assert.equal(posts(),7);
    if(pendingId)assert.equal(created.id,pendingId);else assert.notEqual(created.id,prior.id);
    const before=f.requests.length,result=await workflow.recheck(input);
    assert.equal(result.workflow.status,'COMPLETED',result.workflow.error??'');assert.equal(posts(),7);
    assert.equal(result.workflow.listingEvidenceContractVersion,'listing-evidence/v5');assert.equal(result.workflow.imageContext?.listing.evidenceBlockers?.[0].field,'age_range_description');
    if(pendingId)assert.equal(result.workflow.id,pendingId);
    assert.ok(f.requests.length>before);assert.deepEqual(result.workflow.slots!.map(slot=>slot.approvedAssetId),prior.slots!.map(slot=>slot.approvedAssetId));
    assert.equal(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(prior.id)!.record_json,oldRun);
    for(const [id,raw] of oldResults)assert.equal(db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(id)!.record_json,raw);
    const calls=f.requests.length,repeat=await workflow.recheck(input);
    assert.equal(repeat.workflow.id,result.workflow.id);assert.equal(repeat.aiCalls,0);assert.equal(f.requests.length,calls);assert.equal(posts(),7);
  }finally{db.close();}
});

for(const version of [undefined,'listing-evidence/v1','listing-evidence/v2'] as const)test(`an empty ${version??'unmarked'} run stamps current evidence before a configuration failure`,async t=>{
  const f=await fixture(t),{workflow,posts}=productionWorkflow(f),input={draftId:f.draft.id,draftRevision:f.draft.revision};
  const starting=workflow.complete(input);workflow.cancel(f.draft.id);const stopped=await starting;
  const old=structuredClone(stopped.workflow);if(version)old.listingEvidenceContractVersion=version;else delete old.listingEvidenceContractVersion;
  assert.equal(old.imageContext,undefined);const db=openDatabase(f.directory);
  try{db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(JSON.stringify(old),old.id);}finally{db.close();}
  f.ai.saveFunctionSettings({id:'deepseek',model:'deepseek-flash',enabled:false});
  const before=f.requests.length,pending=workflow.complete(input),created=workflow.getProgress(f.draft.id)!;
  const failed=await pending;
  assert.equal(created.id,old.id);assert.equal(created.listingEvidenceContractVersion,'listing-evidence/v4');
  assert.equal(failed.workflow.listingEvidenceContractVersion,'listing-evidence/v4');assert.equal(failed.workflow.imageContext,undefined);
  assert.notEqual(failed.workflow.status,'COMPLETED');assert.match(failed.workflow.error??'',/配置并启用/);
  assert.equal(f.requests.length,before);assert.equal(posts(),0);
});

test('the legacy single-image path stamps a new current context and fresh recheck while preserving the old run',async t=>{
  const f=await legacyFixture(t),{workflow,posts}=productionWorkflow(f),now=new Date().toISOString();
  (workflow as any).listing.complete=async()=>({draft:f.amazon.getDraft(f.draft.id),aiCalls:0,previewAttempts:0,remaining:[]});
  const seed=validateStoredImageWorkflowRun({id:randomUUID(),draftId:f.draft.id,productId:f.product.id,productRevision:f.product.revision,variantId:f.draft.variantId,sku:f.draft.sku,status:'RUNNING',stage:'content',attempt:0,maxAttempts:1,contextSha256:null,draftSha256:null,referenceAssets:[],planResultIds:[],candidateIds:[],ocrResultIds:[],reviewResultIds:[],ipReviewResultIds:[],approvedAssetId:null,approvedSha256:null,createdAt:now,updatedAt:now,error:null,imagePolicyVersion:PRODUCT_IMAGE_POLICY_VERSION});
  const first=await (workflow as any).run(seed,f.draft,new AbortController().signal);
  assert.equal(first.workflow.status,'COMPLETED',first.workflow.error??'');
  assert.equal(first.workflow.listingEvidenceContractVersion,'listing-evidence/v5');assert.equal(posts(),1);
  const prior=structuredClone(first.workflow);delete prior.listingEvidenceContractVersion;
  const raw=JSON.stringify(prior),db=openDatabase(f.directory);
  try{
    db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(raw,prior.id);
    const pending=(workflow as any).recheckWithFreshEvidence({draftId:f.draft.id,draftRevision:first.draft.revision,sourceWorkflowId:prior.id});
    const created=workflow.getProgress(f.draft.id)!,completed=await pending;
    assert.equal(created.listingEvidenceContractVersion,'listing-evidence/v5');assert.notEqual(created.id,prior.id);
    assert.equal(completed.workflow.status,'COMPLETED',completed.workflow.error??'');assert.equal(completed.workflow.listingEvidenceContractVersion,'listing-evidence/v5');
    assert.equal(completed.workflow.approvedAssetId,prior.approvedAssetId);assert.equal(posts(),1);
    assert.equal(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(prior.id)!.record_json,raw);
    db.prepare('INSERT INTO facts VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),f.product.id,'适用年龄','不适合儿童','manual','current exclusion fixture','human_confirmed',99);
    const current=f.amazon.getDraft(f.draft.id),changed=f.amazon.saveDraft({id:current.id,revision:current.revision,attributes:{...current.attributes,item_name:[{value:'Child Coaster'}]}}),before=f.requests.length;
    for(const version of [undefined,'listing-evidence/v1','listing-evidence/v2'] as const){
      const old={...prior,...(version?{listingEvidenceContractVersion:version}:{})},bytes=JSON.stringify(old);
      db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(bytes,prior.id);
      await assert.rejects(workflow.recheck({draftId:changed.id,draftRevision:changed.revision,sourceWorkflowId:prior.id}));
      assert.equal(f.requests.length,before);assert.equal(posts(),1);
      assert.equal(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(prior.id)!.record_json,bytes);
    }
  }finally{db.close();}
});

test('current image authorization checks the approved slot plan and preserves superseded rejected captions',async t=>{
  const f=await fixture(t),{workflow,posts}=productionWorkflow(f);let detailPlans=0,generations=0;
  (workflow as any).listing.complete=async()=>({draft:f.amazon.getDraft(f.draft.id),aiCalls:0,previewAttempts:0,remaining:[]});
  const db=openDatabase(f.directory),input={draftId:f.draft.id,draftRevision:f.draft.revision};
  db.prepare('UPDATE variants SET normalized_spec=? WHERE id=?').run('Children Blue',f.product.variants[0].id);
  await confirmSourceConsistencyFixture(f.directory,f.store,f.product.id);
  const pending=workflow.complete(input);workflow.cancel(f.draft.id);const stopped=await pending;
  const seed={...stopped.workflow,slotPolicy:'seven-provisional-v1'};
  db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(JSON.stringify(seed),seed.id);
  const generator=(workflow as any).generation as ImageGenerationService,generate=generator.generateForWorkflow.bind(generator);
  generator.generateForWorkflow=async(...args)=>{if(++generations===2)throw Object.assign(new AiError('PROVIDER_ERROR'),{definitive:true});return generate(...args);};
  f.respond((operation,payload)=>{
    if(operation==='ip-upload')return new Response(null,{status:200});
    if(operation==='image-plan'&&payload.slot?.index===2&&++detailPlans===1)return chat({kind:'image-plan',prompt:'Preserve the selected SKU.',textMode:'planned',expectedText:[{text:'Child Coaster',evidenceIds:[`${f.product.variants[0].id}:spec`]}],ipRisk:{verdict:'PASS',findings:[]},productUnderstanding:understanding(payload)});
  });
  try{
    const first=await workflow.complete(input);
    assert.equal(first.workflow.status,'COMPLETED',first.workflow.error??'');assert.equal(posts(),7);
    assert.equal(first.workflow.slots![1].attempts[0].state,'RETRYABLE_FAILURE');assert.equal(first.workflow.slots![1].attempts.at(-1)!.state,'PASSED');
    const old=structuredClone(first.workflow);delete old.listingEvidenceContractVersion;
    const raw=JSON.stringify(old),oldPlan=old.slots![1].attempts[0].planResultId!,oldPlanBytes=db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(oldPlan)!.record_json;
    db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(raw,old.id);
    db.prepare('UPDATE variants SET source_spec=? WHERE id=?').run('不适合儿童',f.product.variants[0].id);
  await confirmSourceConsistencyFixture(f.directory,f.store,f.product.id);
    const before=f.requests.length;
    assert.deepEqual(approvedWorkflowAssets(db,f.amazon.getDraft(f.draft.id),f.store.getProduct(f.product.id)),old.slots!.map(slot=>({id:slot.approvedAssetId,sha256:slot.approvedSha256})));
    assert.equal(f.requests.length,before);
    const rechecked=await workflow.recheck({...input,sourceWorkflowId:old.id});assert.equal(rechecked.workflow.status,'COMPLETED',rechecked.workflow.error??'');assert.equal(posts(),7);
    assert.equal(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(old.id)!.record_json,raw);
    assert.equal(db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(oldPlan)!.record_json,oldPlanBytes);
  }finally{db.close();}
});

for(const version of [undefined,'listing-evidence/v1'] as const)test(`old ${version??'unmarked'} captions contradicted by current selected exclusions authorize no images or paid recheck`,async t=>{
  const f=await legacyFixture(t),{workflow,posts}=productionWorkflow(f),db=openDatabase(f.directory);
  try{
    db.prepare('UPDATE variants SET source_spec=?,normalized_spec=? WHERE id=?').run('不适合儿童','Children Blue',f.product.variants[0].id);
  await confirmSourceConsistencyFixture(f.directory,f.store,f.product.id);
    const listing=(workflow as any).listing as ListingAiService,strictContext=listing.currentContext.bind(listing);
    listing.currentContext=(...args)=>{const context=strictContext(...args);context.evidence=context.evidence.filter(e=>e.id!==`${f.product.variants[0].id}:age_range_description`);return context;};
    const specId=`${f.product.variants[0].id}:spec`,set=sceneSet();
    set.slots[1]={...set.slots[1],role:'selling_point',focus:'Child Coaster',evidenceIds:[specId],textMode:'planned',expectedText:[{text:'Child Coaster',evidenceIds:[specId]}]};
    f.respond((operation,payload)=>{
      if(operation==='ip-upload')return new Response(null,{status:200});
      if(operation==='image-plan')return chat({...(payload.setPolicy&&!payload.slot?{setPlan:set}:{}),kind:'image-plan',prompt:'Preserve the selected SKU.',textMode:payload.slot?.index===2?'planned':'none',expectedText:payload.slot?.index===2?set.slots[1].expectedText:[],ipRisk:{verdict:'PASS',findings:[]},productUnderstanding:understanding(payload)});
    });
    await listing.reviewCurrentForImages({draftId:f.draft.id,draftRevision:f.draft.revision});
    const first=await workflow.complete({draftId:f.draft.id,draftRevision:f.draft.revision});
    assert.equal(first.workflow.status,'COMPLETED',first.workflow.error??'');assert.equal(posts(),7);
    const old=structuredClone(first.workflow);if(version)old.listingEvidenceContractVersion=version;else delete old.listingEvidenceContractVersion;
    const raw=JSON.stringify(old),oldResults=new Map<string,string>();
    db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(raw,old.id);
    for(const row of db.prepare('SELECT id,record_json FROM ai_results').all()){
      const value=JSON.parse(String(row.record_json));if(version&&(value.listingContext||value.imageContext))value.listingEvidenceContractVersion=version;else delete value.listingEvidenceContractVersion;
      const bytes=JSON.stringify(value);oldResults.set(String(row.id),bytes);db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(bytes,row.id);
    }
    listing.currentContext=strictContext;
    assert.deepEqual(workflow.getProgress(f.draft.id),old);
    assert.equal(strictContext(first.draft,f.store.getProduct(f.product.id),f.amazon.executionTargetScope(first.draft.targetId).generation).fields.some(field=>field.name==='age_range_description'),false);
    let authorized=false;
    try{authorized=!!approvedWorkflowAssets(db,f.amazon.getDraft(f.draft.id),f.store.getProduct(f.product.id));}catch{}
    const before=f.requests.length;
    try{await workflow.recheck({draftId:f.draft.id,draftRevision:first.draft.revision,sourceWorkflowId:old.id});}catch{}
    assert.deepEqual({newCalls:f.requests.length-before,authorized},{newCalls:0,authorized:false},'current exclusions must reject both image authorization and paid recheck');
    assert.equal(posts(),7);assert.equal(workflowRuns(db,f.draft.id).length,1);
    assert.equal(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(old.id)!.record_json,raw);
    for(const [id,bytes] of oldResults)assert.equal(db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(id)!.record_json,bytes);
  }finally{db.close();}
});

test('real source-image color adoption keeps its citations through approved images and zero-call reuse',async t=>{
  const f=await legacyFixture(t,false,true),product=f.store.saveProduct({...saveInput(f.product),facts:f.product.facts.filter(fact=>fact.name!=='适用年龄'),variants:saveInput(f.product).variants.map(v=>({...v,originalSpec:'型号: 602Q',normalizedSpec:'602Q'}))});
  await confirmSourceConsistencyFixture(f.directory,f.store,product.id);
  let draft=await f.amazon.createDraft({productId:product.id,variantId:product.variants[0].id,targetId:f.draft.targetId,productType:f.draft.schema.productType,parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'});
  const market=draft.marketplaceId;
  draft=f.amazon.saveDraft({id:draft.id,revision:draft.revision,attributes:{item_name:[{value:'Silicone Coaster',marketplace_id:market,language_tag:'en_US'}],material:[{value:'Silicone',marketplace_id:market}],age_range_description:[{value:'Adult'}],brand:[{value:'Generic',marketplace_id:market}],purchasable_offer:[{marketplace_id:market,currency:'USD',audience:'ALL',our_price:[{schedule:[{value_with_tax:10}]}]}]}});
  f.respond((operation,payload)=>{
    if(operation==='source-color')return chat({kind:'source-color',verdict:'DETERMINED',colors:['Silver'],reason:'Visible product body.',referenceAssetIds:payload.referenceImages.map((image:any)=>image.assetId)});
    if(!operation&&!payload.candidate){const image=payload.evidence.find((e:any)=>e.source==='source_image'),material=payload.evidence.find((e:any)=>e.meaning==='material');return chat({kind:'amazon-fields',candidates:[{field:'color',items:[{value:'Silver',evidenceIds:[image.id],transformation:'copy'}]},{field:'age_range_description',items:[{value:'Adult',evidenceIds:[material.id,image.id],transformation:'infer',inferenceReason:'Ordinary product judgment from the actual coaster category and silicone material.'}]}],missing:payload.fields.filter((field:any)=>!['color','age_range_description'].includes(field.name)).map((field:any)=>({field:field.name,reason:'Existing copy is retained.'}))});}
    if(!operation&&payload.candidate)return chat(currentReview(payload));
  });
  const reference={draftId:draft.id,draftRevision:draft.revision};await f.listing.prepareSourceColors(reference);
  const suggestion=await f.listing.suggest(reference),review=await f.listing.review({...reference,suggestionResultId:suggestion.id});
  draft=await f.listing.adopt({...reference,suggestionResultId:suggestion.id,reviewResultId:review.id,fields:['color','age_range_description']});
  assert.equal(draft.fieldAdoptions!.at(-1)!.changes[0].evidence[0].source,'source_image');
  await f.listing.reviewCurrentForImages({draftId:draft.id,draftRevision:draft.revision});
  const {workflow,posts}=productionWorkflow(f),request={draftId:draft.id,draftRevision:draft.revision},first=await workflow.complete(request);
  assert.equal(first.workflow.status,'COMPLETED',JSON.stringify({error:first.workflow.error,stage:first.workflow.stage,requests:f.requests.map(r=>r.operation)}));assert.equal(posts(),7);
  const before=f.requests.length,original=JSON.stringify(first.workflow.imageContext),hash=first.workflow.contextSha256;
  const db=openDatabase(f.directory);try{assert.equal(approvedWorkflowAssets(db,f.amazon.getDraft(draft.id),f.store.getProduct(product.id))!.length,7);}finally{db.close();}
  assert.equal((await workflow.complete(request)).workflow.id,first.workflow.id);
  const reused=await workflow.recheck({...request,sourceWorkflowId:first.workflow.id});assert.equal(reused.workflow.approvalReuse?.sourceRunId,first.workflow.id);
  assert.equal(f.requests.length,before);assert.equal(posts(),7);assert.equal(JSON.stringify(workflow.getProgress(draft.id)!.imageContext),original);assert.equal(workflow.getProgress(draft.id)!.contextSha256,hash);
  const source=f.store.getAssetRecord(product.assets[0].id)!;writeFileSync(join(f.directory,source.originalPath),Buffer.from('changed source pixels'));
  await assert.rejects(f.listing.snapshotCurrentForImages(request));assert.equal(f.requests.length,before);
});

for(const incomplete of [false,true])test(`legacy conflicts block ${incomplete?'interrupted':'completed'} image continuation while preserving paid history`,async t=>{
  const f=await legacyFixture(t),{workflow,posts}=productionWorkflow(f,incomplete?1:undefined);
  const reference={draftId:f.draft.id,draftRevision:f.draft.revision},first=await workflow.complete(reference);
  assert.equal(first.workflow.status,incomplete?'FAILED':'COMPLETED',first.workflow.error??'');
  const db=openDatabase(f.directory);try{
    // Recreate an upgrade-era source conflict that the old context omitted.
    db.prepare('INSERT INTO facts VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),f.product.id,'Material','Silicone','manual','fixture','conflicting',99);
    const before=String(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(first.workflow.id)!.record_json),requests=f.requests.length,images=posts(),assets=f.store.getProduct(f.product.id).assets.length;
    await assert.rejects(async()=>workflow.complete(reference),/冲突/);
    if(!incomplete){
      await assert.rejects(workflow.recheck({...reference,sourceWorkflowId:first.workflow.id}),/冲突/);
      await assert.rejects(async()=>(workflow as any).recheckWithFreshEvidence({...reference,sourceWorkflowId:first.workflow.id}),/冲突/);
      assert.throws(()=>approvedWorkflowAssets(db,f.amazon.getDraft(f.draft.id),f.store.getProduct(f.product.id)),/冲突|来源规格、图片、店铺或站点已变化/);
    }
    assert.equal(f.requests.length,requests);assert.equal(posts(),images);assert.equal(f.store.getProduct(f.product.id).assets.length,assets);
    assert.equal(String(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(first.workflow.id)!.record_json),before);
    assert.equal(workflowRuns(db,f.draft.id).length,1);assert.equal(workflow.getProgress(f.draft.id)!.id,first.workflow.id);
  }finally{db.close();}
});

test('image contexts accept only an explicit copy-review skip bound to the current listing and copy', async t => {
  const f = await fixture(t), context = withoutCopyReview(f.context);
  assert.deepEqual(validateProductImageContext(context), context);
  const bypass = context.copyReviewBypass!;
  for (const changed of [
    { ...context, copyReviewBypass: undefined },
    { ...context, listingReviewResultId: f.context.listingReviewResultId },
    { ...context, copyReviewBypass: { ...bypass, policy: 'ignored' } },
    { ...context, copyReviewBypass: { ...bypass, at: 'invalid-date' } },
    { ...context, copyReviewBypass: { ...bypass, contextSha256: '0'.repeat(64) } },
    { ...context, copyReviewBypass: { ...bypass, copySha256: '0'.repeat(64) } },
    { ...context, listing: { ...context.listing, sku: 'changed' } },
    { ...context, currentListingCopy: [{ field: 'item_name', values: ['Different copy'] }] },
    { ...context, policyVersion: 'product-image/vision-v2', ipSource: undefined },
  ]) assert.throws(() => validateProductImageContext(changed));
  assert.deepEqual(validateProductImageContext(f.context), f.context);
  assert.equal(listingFingerprint(validateProductImageContext(f.context)), listingFingerprint(f.context));
});

test('unreviewed image provenance omits review IDs while preserving plan, OCR and risk references', async t => {
  const f = await fixture(t), context = withoutCopyReview(f.context);
  const { writeCopyReviewSettings } = await import('../src/main/listing-ai/review-settings.ts');
  const db = openDatabase(f.directory);
  try { writeCopyReviewSettings(db, { enabled: false }); } finally { db.close(); }
  const before = f.requests.length;
  const plan = await f.ai.imagePlan(context, () => {});
  const ip = await f.ai.reviewGeneratedImageRisk(context, plan, f.candidate, f.bytes, () => {});
  const ocr = await f.ai.recognizeGeneratedImage(context, f.candidate, f.bytes, () => {});
  const review = await f.ai.reviewGeneratedImage(context, plan, ocr, f.candidate, () => {});
  assert.deepEqual(plan.sourceResultIds, []);
  assert.deepEqual(ip.sourceResultIds, [plan.id]);
  assert.deepEqual(ocr.sourceResultIds, []);
  assert.deepEqual(review.sourceResultIds, [plan.id, ocr.id]);
  assert.equal(f.requests.slice(before).some(request => request.operation === 'listing-current-review'), false);
  for (const result of [plan, ip, ocr, review]) {
    assert.deepEqual(validateAiResult(result), result);
    const extraIds = result.output.kind === 'image-plan' ? [randomUUID(), randomUUID()] : [f.context.listingReviewResultId, ...result.sourceResultIds];
    assert.throws(() => validateAiResult({ ...result, sourceResultIds: extraIds }));
  }
  const repair = await f.ai.imagePlan(context, () => {}, { previousPlanId: plan.id, issues: ['Improve the scene.'] });
  assert.deepEqual(repair.sourceResultIds, [plan.id]);
  const enabledDb = openDatabase(f.directory);
  try { writeCopyReviewSettings(enabledDb, { enabled: true }); } finally { enabledDb.close(); }
  const paidBefore = f.requests.length;
  await assert.rejects(f.ai.imagePlan(context, () => {}), (error: unknown) => error instanceof AiError && error.code === 'SOURCE_CHANGED');
  assert.equal(f.requests.length, paidBefore);
  assert.deepEqual(validateAiResult(review), review);
});

test('unreviewed seven-image history retains its own proof when later rechecked with copy review enabled', async t => {
  const f = await fixture(t); let images = 0;
  f.respond(operation => operation === 'ip-upload' ? new Response(null, { status: 200 }) : undefined);
  const generation = new ImageGenerationService(f.directory, f.store, mockStorage, { decodePreview: bytes => bytes, fetch: async () => {
    const bytes = Buffer.from(f.bytes); bytes[32] = ++images; return Response.json({ data: [{ b64_json: bytes.toString('base64') }] });
  } });
  generation.saveConnection({ model: 'openai/gpt-image-2.5-sunburst', enabled: true, apiKey: 'fixture-image-key' });
  const workflow = new ImageWorkflowService(f.directory, f.store, f.amazon, f.ai, generation, { listing: {
    complete: async () => ({ draft: f.amazon.getDraft(f.draft.id), aiCalls: 0, previewAttempts: 0, remaining: [] }),
    reviewCurrentForImages: (input, signal) => f.listing.reviewCurrentForImages(input, signal),
    snapshotCurrentForImages: (input, signal) => f.listing.snapshotCurrentForImages(input, signal),
  } });
  f.cleanup(async () => { await workflow.close(); await generation.close(); });
  workflow.saveCopyReviewSettings({ enabled: false });
  const before = f.requests.length, first = await workflow.complete({ draftId: f.draft.id, draftRevision: f.draft.revision });
  assert.equal(first.workflow.status, 'COMPLETED', first.workflow.error ?? '');
  assert.equal(first.workflow.copyReviewEnabled, false);
  assert.equal(first.workflow.imageContext!.listingReviewResultId, null);
  assert.equal(f.requests.slice(before).some(request => request.operation === 'listing-current-review'), false);
  assert.equal(first.workflow.slots![0].attempts[0].reviewResultId !== null, true);
  assert.equal(first.workflow.slots!.every(slot => slot.attempts[0].ipReviewResultId !== null), true);
  const db = openDatabase(f.directory);
  try {
    const results = new Map(f.ai.listResults(f.product.id).filter(result => result.output.kind !== 'listing-current-review').map(result => [result.id, result]));
    const calls = new Map(db.prepare('SELECT record_json FROM ai_calls').all().map(row => { const call = JSON.parse(String(row.record_json)) as AiCall; return [call.id, call]; }));
    assert.doesNotThrow(() => assertImageWorkflowHistory(db, results, calls));
    const plan = results.get(first.workflow.slots![0].attempts[0].planResultId!)!;
    results.set(plan.id, { ...plan, sourceResultIds: [f.context.listingReviewResultId!] });
    assert.throws(() => assertImageWorkflowHistory(db, results, calls));
    results.set(plan.id, plan);
    results.delete(first.workflow.slots![0].attempts[0].ocrResultId!);
    assert.throws(() => assertImageWorkflowHistory(db, results, calls));
  } finally { db.close(); }
  workflow.saveCopyReviewSettings({ enabled: true });
  const current = f.amazon.getDraft(f.draft.id);
  const rechecked = await workflow.recheck({ draftId: current.id, draftRevision: current.revision, sourceWorkflowId: first.workflow.id });
  assert.equal(rechecked.workflow.status, 'COMPLETED', rechecked.workflow.error ?? '');
  assert.equal(rechecked.workflow.imageContext?.copyReviewBypass, undefined);
  assert.equal(rechecked.workflow.setPlanResultId, first.workflow.setPlanResultId);
  assert.equal(images, 7);
  const freshRecheck = workflow as unknown as { recheckWithFreshEvidence(input: unknown): ReturnType<ImageWorkflowService['recheck']> };
  const again = await freshRecheck.recheckWithFreshEvidence({ draftId: current.id, draftRevision: current.revision, sourceWorkflowId: rechecked.workflow.id });
  assert.equal(again.workflow.status, 'COMPLETED', again.workflow.error ?? '');
  assert.equal(again.workflow.setPlanResultId, first.workflow.setPlanResultId);
  await createWorkspaceBackup(f.directory, join(f.directory, 'copy-policy-history.htcbackup'), 'copy policy image history fixture passphrase');
});

test('text review sends explicit empty OCR items without planning descriptions', async t => {
  const f = await fixture(t);
  const context: ProductImageContext = { ...f.context, setPolicy: 'seven-product-v2', referenceMeasurements: [], setPlan: sceneSet(), slot: { index: 1, total: 7, provisional: true } };
  const plan = await f.ai.imagePlan(context, () => {}), ocr = await f.ai.recognizeGeneratedImage(context, f.candidate, f.bytes, () => {});
  const review = await f.ai.reviewGeneratedImage(context, plan, ocr, f.candidate, () => {});
  const request = f.requests.at(-1)!;
  assert.deepEqual(request.payload.reviewItems, []);
  assert.deepEqual(request.payload.unverifiedOcr, { text: '', lines: [] });
  assert.deepEqual(request.payload.plan, { textMode: 'none', expectedText: [] });
  assert.deepEqual(request.payload.slotBrief, { index: 1, role: 'main_scene' });
  for (const key of ['productUnderstanding', 'prompt', 'scene', 'ipRisk']) assert.ok(!JSON.stringify(request.payload).includes(`"${key}":`));
  assert.match(request.body.messages[0].content, /summary.*unverifiedOcr\.text/);
  assert.match(request.body.messages[0].content, /reviewItems.*empty.*checks.*\[\]/);
  assert.equal(review.output.kind, 'image-text-review');
  if (review.output.kind !== 'image-text-review') throw Error('Unexpected review');
  assert.equal(review.output.verdict, 'PASS'); assert.deepEqual(review.output.checks, []);
});

test('captured visual-summary response is rejected instead of dropping its extra OCR check', async t => {
  const f = await fixture(t);
  const context: ProductImageContext = { ...f.context, setPolicy: 'seven-product-v2', referenceMeasurements: [], setPlan: sceneSet(), slot: { index: 1, total: 7, provisional: true } };
  f.respond((operation, payload) => operation === 'image-plan' ? chat({ kind: 'image-plan', prompt: 'Use the selected product without text.', textMode: 'none', expectedText: [], ipRisk: { verdict: 'PASS', findings: [] }, productUnderstanding: { ...understanding(payload), summary: visualSummaryReview.checks[0].text } }) : operation === 'image-text-review' ? chat(visualSummaryReview) : undefined);
  const plan = await f.ai.imagePlan(context, () => {}), ocr = await f.ai.recognizeGeneratedImage(context, f.candidate, f.bytes, () => {});
  assert.equal(ocr.output.kind, 'generated-image-ocr');
  if (ocr.output.kind !== 'generated-image-ocr' || plan.output.kind !== 'image-plan') throw Error('Unexpected result');
  assert.equal(ocr.output.text, ''); assert.deepEqual(ocr.output.lines, []);
  assert.equal(visualSummaryReview.checks[0].text, plan.output.productUnderstanding!.summary);
  await assert.rejects(f.ai.reviewGeneratedImage(context, plan, ocr, f.candidate, () => {}), (error: unknown) => error instanceof AiError && error.code === 'OUTPUT_INVALID');
  assert.equal(f.ai.listResults(f.product.id).some(result => result.output.kind === 'image-text-review'), false);
  assert.equal(f.requests.filter(request => request.operation === 'image-text-review').length, 1);
});

test('text review enumerates the exact OCR summary and every nonempty original line', async t => {
  const f = await fixture(t);
  const context: ProductImageContext = { ...f.context, setPolicy: 'seven-product-v2', referenceMeasurements: [], setPlan: sceneSet(), slot: { index: 1, total: 7, provisional: true } };
  const items = [{ source: 'summary', index: 0, text: 'CCV(O SPP ' }, { source: 'line', index: 0, text: 'CCV(O' }, { source: 'line', index: 2, text: 'SPP' }];
  const output = { verdict: 'NEEDS_CHANGES', checks: items.map(item => ({ ...item, verdict: 'UNSUPPORTED', evidenceIds: [], reason: 'Unexpected text on a text-free main image.' })), expectedTextChecks: [], noTextVerified: false, issues: ['Remove the unwanted OCR text.'] };
  f.respond(operation => operation === 'ocr' ? Response.json({ Code: 'success', Data: { Width: 256, Height: 256, Content: 'CCV(O SPP ', SubImageCount: 1, SubImages: [{ SubImageId: 0, BlockInfo: { BlockCount: 3, BlockDetails: ['CCV(O', '', 'SPP'].map((text, index) => ({ BlockId: index, BlockContent: text, BlockConfidence: 55 })) } }] } }) : operation === 'image-text-review' ? chat(output) : undefined);
  const plan = await f.ai.imagePlan(context, () => {}), ocr = await f.ai.recognizeGeneratedImage(context, f.candidate, f.bytes, () => {});
  const review = await f.ai.reviewGeneratedImage(context, plan, ocr, f.candidate, () => {});
  assert.deepEqual(f.requests.at(-1)!.payload.reviewItems, items);
  assert.deepEqual(f.requests.at(-1)!.payload.unverifiedOcr, { text: 'CCV(O SPP ', lines: [{ text: 'CCV(O' }, { text: '' }, { text: 'SPP' }] });
  if (review.output.kind !== 'image-text-review') throw Error('Unexpected review');
  assert.equal(review.output.verdict, 'NEEDS_CHANGES'); assert.equal(review.output.checks[0].text, 'CCV(O SPP ');
  f.respond(operation => operation === 'image-text-review' ? chat({ ...output, checks: output.checks.slice(1) }) : undefined);
  await assert.rejects(f.ai.reviewGeneratedImage(context, plan, ocr, f.candidate, () => {}), (error: unknown) => error instanceof AiError && error.code === 'OUTPUT_INVALID');
});

test('legacy current-copy review uses the shared item and claim verdict contract', async t => {
  const f = await legacyFixture(t);
  assert.ok(f.requests[0].body.messages[0].content.includes(LISTING_REVIEW_OUTPUT_RULES));
});

test('set planning states the existing dimension reason, unit and numeric evidence bounds', async t => {
  const f = await fixture(t);
  await f.ai.imagePlan({ ...f.context, setPolicy: 'seven-product-v2', referenceMeasurements: [] }, () => {});
  const system = f.requests.at(-1)!.body.messages[0].content;
  assert.match(system, /dimensionReason<=1000/);
  assert.match(system, /cm, mm, in, or inches/);
  assert.match(system, /double-quote inch symbols/);
  assert.match(system, /background props and excluded unknown dimensions.*qualitatively/);
});

test('legacy current-copy review reports omitted wording without granting image planning approval', async t => {
  const f = await legacyFixture(t);
  f.respond((operation, payload) => {
    if (operation !== 'listing-current-review') return undefined;
    const review = currentReview(payload);
    const check = review.checks.find((c: any) => c.field === 'item_name');
    check.claims[0].text = check.claims[0].text.split(' ')[0];
    return chat(review);
  });
  const before=f.requests.length,prior=f.ai.listResults(f.product.id).length;
  await assert.rejects(f.ai.reviewCurrentListing(f.context.listing,f.context.currentListingCopy,async()=>{}),(error:any)=>error.code==='OUTPUT_INVALID');
  assert.equal(f.ai.listResults(f.product.id).length,prior,'a failed review never creates a new approval or a fabricated product correction');
  const failed=f.ai.listCalls().find(call=>call.status==='FAILED');assert.equal(failed?.errorCode,'OUTPUT_INVALID');
  assert.equal(f.requests.length,before+1);
});

test('printed reference dimensions retain original OCR provenance and cannot be forged or moved to another image',async t=>{
  const f=await fixture(t);
  f.respond((operation,payload)=>{
    if(operation==='ocr')return Response.json({Code:'success',Data:{Width:256,Height:256,Content:'Diameter 8 cm',SubImageCount:1,SubImages:[{SubImageId:0,BlockInfo:{BlockCount:1,BlockDetails:[{BlockId:0,BlockContent:'Diameter 8 cm',BlockConfidence:99}]}}]}});
    if(operation==='image-plan'){
      const set=sceneSet(),id=payload.referenceMeasurements[0].id;
      set.dimensionEvidenceIds=[id];set.dimensionReason='Printed diameter confirmed against the attached product image.';
      set.slots[6]={...set.slots[6],role:'dimensions',focus:'Product diameter',evidenceIds:[id],textMode:'planned',expectedText:[{text:'Diameter 8 cm',evidenceIds:[id]}]};
      return chat({kind:'image-plan',prompt:'A tabletop scene.',textMode:'none',expectedText:[],productUnderstanding:understanding(payload),ipRisk:{verdict:'PASS',findings:[]},setPlan:set});
    }
  });
  const ocr=await f.ai.recognize({productId:f.product.id,productRevision:f.product.revision,assetId:f.product.assets[0].id});
  const context:ProductImageContext={...f.context,setPolicy:'seven-product-v2',referenceMeasurements:referenceMeasurementEvidence(ocr)};
  const planned=await f.ai.imagePlan(context,()=>{});assert.equal(planned.output.kind,'image-plan');
  assert.equal(planned.output.kind==='image-plan'&&planned.output.setPlan?.slots[6].role,'dimensions');
  const before=f.requests.length,forged=structuredClone(context);forged.referenceMeasurements![0].text='Diameter 80 cm';
  await assert.rejects(f.ai.imagePlan(forged,()=>{}));assert.equal(f.requests.length,before);
  forged.referenceMeasurements![0].assetId=randomUUID();await assert.rejects(f.ai.imagePlan(forged,()=>{}));assert.equal(f.requests.length,before);
  assert.equal(f.store.getProduct(f.product.id).facts.some(fact=>fact.value.includes('8 cm')),false);
  await createWorkspaceBackup(f.directory,join(f.directory,'reference-dimension.htcbackup'),'source reference measurement backup passphrase');
});
test('seven images through production AI adapters retain auditable slot provenance across backup and restore',async t=>{
  const f=await fixture(t);let imageCount=0;
  f.respond(operation=>operation==='ip-upload'?new Response(null,{status:200}):undefined);
  const generation=new ImageGenerationService(f.directory,f.store,mockStorage,{decodePreview:bytes=>bytes,fetch:async()=>{const bytes=Buffer.from(f.bytes);bytes[32]=++imageCount;return new Response(JSON.stringify({data:[{b64_json:bytes.toString('base64')}]}));}});
  generation.saveConnection({model:'openai/gpt-image-2.5-sunburst',enabled:true,apiKey:'test-only'});
  const workflow=new ImageWorkflowService(f.directory,f.store,f.amazon,f.ai,generation,{listing:{currentContext:(...args)=>f.listing.currentContext(...args),complete:async()=>({draft:f.draft,aiCalls:0,previewAttempts:0,remaining:[]}),reviewCurrentForImages:(input,signal)=>f.listing.reviewCurrentForImages(input,signal)}});
  f.cleanup(async()=>{await workflow.close();await generation.close();});
  const result=await workflow.complete({draftId:f.draft.id,draftRevision:f.draft.revision});assert.equal(result.workflow.status,'COMPLETED',result.workflow.error??'');
  assert.equal(imageCount,7);const requests=f.requests.filter(item=>item.operation==='image-plan');assert.deepEqual(requests.map(item=>item.payload.slot?.index),[undefined,1,2,3,4,5,6,7]);
  const backup=join(f.directory,'seven.htcbackup'),target=join(f.directory,'seven-restored');await createWorkspaceBackup(f.directory,backup,'seven images backup test passphrase');
  await commitWorkspaceRestore(target,await prepareWorkspaceRestore(target,backup,'seven images backup test passphrase'));
  const restored=openDatabase(target);try{assert.equal(workflowRuns(restored,f.draft.id)[0].slots!.filter(slot=>slot.status==='PASSED').length,7);}finally{restored.close();}
});

test('a saved generated candidate resumes only its missing text review after invalid output and restart', async t => {
  const f = await fixture(t); let imageCount = 0, rejectReview = true;
  f.respond(operation => {
    if (operation === 'ip-upload') return new Response(null, { status: 200 });
    if (operation === 'image-text-review' && rejectReview) { rejectReview = false; return chat(visualSummaryReview); }
  });
  const generation = new ImageGenerationService(f.directory, f.store, mockStorage, { decodePreview: bytes => bytes, fetch: async () => {
    const bytes = Buffer.from(f.bytes); bytes[32] = ++imageCount;
    return Response.json({ data: [{ b64_json: bytes.toString('base64') }] });
  } });
  generation.saveConnection({ model: 'openai/gpt-image-2.5-sunburst', enabled: true, apiKey: 'test-only' });
  const options = { listing: { complete: async () => ({ draft: f.draft, aiCalls: 0, previewAttempts: 0, remaining: [] }), reviewCurrentForImages: (input: Parameters<ListingAiService['reviewCurrentForImages']>[0], signal?: AbortSignal) => f.listing.reviewCurrentForImages(input, signal) } };
  const workflow = new ImageWorkflowService(f.directory, f.store, f.amazon, f.ai, generation, options);
  f.cleanup(async () => { await workflow.close(); await generation.close(); });
  const first = await workflow.complete({ draftId: f.draft.id, draftRevision: f.draft.revision });
  assert.equal(first.workflow.status, 'FAILED'); assert.equal(first.workflow.stage, 'reviewing'); assert.equal(imageCount, 1);
  const saved = first.workflow.slots![0].attempts[0];
  assert.equal(saved.state, 'GENERATED'); assert.ok(saved.candidateId); assert.ok(saved.ipReviewResultId); assert.ok(saved.ocrResultId); assert.equal(saved.reviewResultId, null);
  const requestCount = f.requests.length;
  await workflow.close();
  const restarted = new ImageWorkflowService(f.directory, f.store, f.amazon, f.ai, generation, options);
  f.cleanup(() => restarted.close());
  const resumed = await restarted.complete({ draftId: f.draft.id, draftRevision: f.draft.revision });
  assert.equal(resumed.workflow.status, 'COMPLETED', resumed.workflow.error ?? ''); assert.equal(resumed.workflow.id, first.workflow.id);
  assert.equal(f.requests[requestCount].operation, 'image-text-review');
  const kept = resumed.workflow.slots![0].attempts[0];
  for (const key of ['requestId', 'planResultId', 'candidateId', 'ipReviewResultId', 'ocrResultId'] as const) assert.equal(kept[key], saved[key]);
  assert.ok(kept.reviewResultId); assert.equal(resumed.workflow.slots![0].attempts.length, 1);
  assert.equal(imageCount, 7); assert.equal(f.requests.filter(item => item.operation === 'ImageModeration').length, 7);
  assert.equal(f.requests.filter(item => item.operation === 'ocr').length, 2); // One source OCR plus the main image.
  assert.equal(f.requests.filter(item => item.operation === 'image-text-review').length, 2);
});

test('a source-image size, feature captions and optional scene copy survive the full seven-image pipeline and recheck',async t=>{
  const f=await fixture(t);let imageCount=0;let slot:ReturnType<typeof sceneSet>['slots'][number]|undefined;
  f.respond((operation,payload)=>{
    if(operation==='ip-upload')return new Response(null,{status:200});
    if(operation==='image-plan'){
      const set=payload.frozenSetPlan??sceneSet();
      if(!payload.slot){
        const sizeId=payload.referenceMeasurements[0].id,material=payload.evidence.find((e:any)=>e.meaning==='material').id;
        set.dimensionEvidenceIds=[sizeId];set.dimensionReason='Printed product diameter, read from original reference.';
        set.slots[1]={...set.slots[1],role:'selling_point',focus:'Silicone material',evidenceIds:[material],textMode:'planned',expectedText:[{text:'Silicone',evidenceIds:[material]}]};
        set.slots[2]={...set.slots[2],textMode:'planned',expectedText:[{text:'A quiet moment',evidenceIds:[]}]};
        set.slots[6]={...set.slots[6],role:'dimensions',focus:'Product diameter',evidenceIds:[sizeId],textMode:'planned',expectedText:[{text:'Diameter 8 cm',evidenceIds:[sizeId]}]};
      }
      slot=set.slots[(payload.slot?.index??1)-1];
      return chat({kind:'image-plan',productUnderstanding:{...understanding(payload),summary:'A round coaster. Printed diameter 8 cm.'},ipRisk:{verdict:'PASS',findings:[]},prompt:slot!.prompt,textMode:slot!.textMode,expectedText:slot!.expectedText,...(!payload.slot?{setPlan:set}:{})});
    }
    if(operation==='ocr'){
      const text=imageCount?slot!.expectedText.map(item=>item.text).join(' '):'Diameter 8 cm';
      return Response.json({Code:'success',Data:{Width:256,Height:256,Content:text,SubImageCount:text?1:0,SubImages:text?[{SubImageId:0,BlockInfo:{BlockCount:1,BlockDetails:[{BlockId:0,BlockContent:text,BlockConfidence:99}]}}]:[]}});
    }
    if(operation==='image-text-review'){
      const text=payload.unverifiedOcr.text,evidenceIds=[...new Set(payload.plan.expectedText.flatMap((line:any)=>line.evidenceIds))];
      return chat({verdict:'PASS',checks:text?[{source:'summary',index:0,text,verdict:'SUPPORTED',evidenceIds,reason:'Matches planned supported text.'},{source:'line',index:0,text,verdict:'SUPPORTED',evidenceIds,reason:'Matches planned supported text.'}]:[],expectedTextChecks:payload.plan.expectedText.map((_line:any,index:number)=>({index,present:true,reason:'Same meaning.'})),noTextVerified:!text,issues:[]});
    }
  });
  const prompts:string[]=[];
  const generation=new ImageGenerationService(f.directory,f.store,mockStorage,{decodePreview:bytes=>bytes,fetch:async(_url,init)=>{prompts.push(String(init?.body));const bytes=Buffer.from(f.bytes);bytes[32]=++imageCount;return Response.json({data:[{b64_json:bytes.toString('base64')}]});}});
  generation.saveConnection({model:'openai/gpt-image-2.5-sunburst',enabled:true,apiKey:'test-only'});
  const workflow=new ImageWorkflowService(f.directory,f.store,f.amazon,f.ai,generation,{listing:{currentContext:(...args)=>f.listing.currentContext(...args),complete:async()=>({draft:f.draft,aiCalls:0,previewAttempts:0,remaining:[]}),reviewCurrentForImages:(input,signal)=>f.listing.reviewCurrentForImages(input,signal)}});
  f.cleanup(async()=>{await workflow.close();await generation.close();});
  const first=await workflow.complete({draftId:f.draft.id,draftRevision:f.draft.revision});
  assert.equal(first.workflow.status,'COMPLETED',first.workflow.error??'');assert.equal(imageCount,7);
  assert.deepEqual(first.workflow.setPlan?.slots.map(slot=>slot.role),['main_scene','selling_point','scene','scene','scene','scene','dimensions']);
  assert.equal(first.workflow.imageContext?.referenceMeasurements?.length,1);
  const rechecked=await workflow.recheck({draftId:f.draft.id,draftRevision:f.draft.revision,sourceWorkflowId:first.workflow.id});
  assert.equal(rechecked.workflow.status,'COMPLETED',rechecked.workflow.error??'');assert.equal(imageCount,7);
  assert.equal(rechecked.workflow.setPlanResultId,first.workflow.setPlanResultId);
  await createWorkspaceBackup(f.directory,join(f.directory,'full-size-set.htcbackup'),'full image set measurement backup passphrase');
});

test('equivalent draft saves resume unknown candidates without changing historical image evidence or resetting attempts',async t=>{
  for(const change of ['no-op','image-url']){
    const f=await fixture(t);let posts=0,loseResponse=true;
    f.respond(operation=>operation==='ip-upload'?new Response(null,{status:200}):undefined);
    const generation=new ImageGenerationService(f.directory,f.store,mockStorage,{decodePreview:bytes=>bytes,fetch:async()=>{const bytes=Buffer.from(f.bytes);bytes[32]=++posts;return Response.json({data:[{b64_json:bytes.toString('base64')}]});}});
    generation.saveConnection({model:'openai/gpt-image-2.5-sunburst',enabled:true,apiKey:'test-only'});
    const send=generation.generateForWorkflow.bind(generation);
    generation.generateForWorkflow=async(...args)=>{const candidate=await send(...args);if(posts===2&&loseResponse){loseResponse=false;throw new AiError('TIMEOUT');}return candidate;};
    const workflow=new ImageWorkflowService(f.directory,f.store,f.amazon,f.ai,generation,{listing:{currentContext:(...args)=>f.listing.currentContext(...args),complete:async()=>({draft:f.draft,aiCalls:0,previewAttempts:0,remaining:[]}),reviewCurrentForImages:(input,signal)=>f.listing.reviewCurrentForImages(input,signal)}});
    f.cleanup(async()=>{await workflow.close();await generation.close();});
    const first=await workflow.complete({draftId:f.draft.id,draftRevision:f.draft.revision});
    assert.equal(first.workflow.slots![0].status,'PASSED');assert.equal(first.workflow.slots![1].status,'UNKNOWN');
    const history=JSON.stringify(f.ai.listResults(f.product.id)),stamp=JSON.stringify(first.workflow.imageContext),ids=first.workflow.slots!.slice(0,2).map(slot=>slot.attempts[0].requestId);
    const saved=f.amazon.saveDraft({id:f.draft.id,revision:f.draft.revision,attributes:{...f.draft.attributes,...(change==='image-url'?{main_product_image_locator:[{marketplace_id:f.draft.marketplaceId,media_location:'https://images.example.com/replaced.png'}]}:{})}});
    assert.ok(saved.revision>f.draft.revision);
    const resumed=await workflow.complete({draftId:f.draft.id,draftRevision:saved.revision});
    assert.equal(resumed.workflow.status,'COMPLETED',resumed.workflow.error??change);assert.equal(resumed.workflow.id,first.workflow.id);assert.equal(posts,7);
    assert.equal(JSON.stringify(resumed.workflow.imageContext),stamp);assert.equal(resumed.workflow.slots![0].approvedAssetId,first.workflow.slots![0].approvedAssetId);
    assert.deepEqual(resumed.workflow.slots!.slice(0,2).map(slot=>slot.attempts[0].requestId),ids);assert.ok(resumed.workflow.slots!.every(slot=>slot.attempts.length===1));
    const before=JSON.parse(history) as AiResult[];assert.deepEqual(before.map(result=>f.ai.getResult(result.id)),before);
    await createWorkspaceBackup(f.directory,join(f.directory,'equivalent.htcbackup'),'equivalent draft backup passphrase');
  }
});

test('IP moderation persists candidate-bound provenance and reserves one usage attempt for token, upload and check', async t => {
  const f=await fixture(t),plan=await f.ai.imagePlan(f.context,()=>{});
  const result=await f.ai.reviewGeneratedImageRisk(f.context,plan,f.candidate,f.bytes,()=>{});
  assert.equal(result.output.kind,'image-ip-review');
  if(result.output.kind!=='image-ip-review')throw Error('Wrong result');
  assert.equal(result.output.verdict,'PASS'); assert.deepEqual(result.output.candidate,f.candidate);
  assert.deepEqual(result.sourceResultIds,[f.context.listingReviewResultId,plan.id]);
  assert.deepEqual(validateAiResult(result),result); assert.ok(f.ai.listResults(f.product.id).some(value=>value.id===result.id));
  assert.deepEqual(f.requests.slice(-3).map(request=>request.operation),['DescribeUploadToken','ip-upload','ImageModeration']);
  const usage=f.ai.getUsageSummary('aliyun-image-risk'); assert.equal(usage.attempts,1); assert.equal(usage.processedImages,1);
});

test('IP moderation rejects changed bytes, rejected source plans and zero budget before network requests',async t=>{
  const f=await fixture(t),plan=await f.ai.imagePlan(f.context,()=>{}),before=f.requests.length;
  const changed=Buffer.from(f.bytes); changed[32]^=1;
  await assert.rejects(f.ai.reviewGeneratedImageRisk(f.context,plan,f.candidate,changed,()=>{}));
  const rejected=structuredClone(plan); if(rejected.output.kind==='image-plan')rejected.output.ipRisk={verdict:'BLOCKED',findings:[{category:'brand',name:'Example',evidence:'Visible logo',referenceAssetIds:[f.context.referenceAssets[0].assetId]}]};
  await assert.rejects(f.ai.reviewGeneratedImageRisk(f.context,rejected,f.candidate,f.bytes,()=>{}));
  f.ai.setUsagePolicy({providerId:'aliyun-image-risk',dailyCallLimit:0,dailyTokenLimit:null});
  await assert.rejects(f.ai.reviewGeneratedImageRisk(f.context,plan,f.candidate,f.bytes,()=>{})); assert.equal(f.requests.length,before);
});

test('cancellation and key rotation during temporary upload cannot send a later moderation request or save PASS',async t=>{
  for(const change of ['cancel','rotate'] as const){
    const f=await fixture(t),plan=await f.ai.imagePlan(f.context,()=>{}),controller=new AbortController();
    f.respond(operation=>{if(operation==='ip-upload'){
      if(change==='cancel')controller.abort();
      else f.ai.saveConnection({id:'aliyun',accessKeyId:'rotated-key-id',accessKeySecret:'rotated-key-secret'});
    }return undefined;});
    await assert.rejects(f.ai.reviewGeneratedImageRisk(f.context,plan,f.candidate,f.bytes,()=>{},controller.signal));
    assert.equal(f.requests.some(request=>request.operation==='ImageModeration'),false);
    assert.equal(f.ai.listResults(f.product.id).some(result=>result.output.kind==='image-ip-review'),false);
  }
});

test('zero OCR requires an explicit text-free plan and independent no-text verification', async t => {
  const f = await fixture(t), plan = await f.ai.imagePlan(f.context,() => {}), ocr = await f.ai.recognizeGeneratedImage(f.context,f.candidate,f.bytes,() => {});
  f.respond(operation => operation === 'image-text-review' ? chat({ verdict: 'PASS', checks: [], expectedTextChecks: [], noTextVerified: false, issues: [] }) : undefined);
  await assert.rejects(f.ai.reviewGeneratedImage(f.context,plan,ocr,f.candidate,() => {}));
  assert.equal(f.ai.listResults(f.product.id).some(result => result.output.kind === 'image-text-review'),false);
});

test('planned text missing from OCR cannot PASS even when a reviewer says it is present', async t => {
  const f = await fixture(t); f.context.purpose = 'detail';
  f.respond((operation,payload) => operation === 'image-plan' ? chat({ kind: 'image-plan', prompt: 'Show the exact text Silicone.', textMode: 'planned', expectedText: [{ text: 'Silicone', evidenceIds: [payload.evidence.find((e: any) => e.meaning === 'material').id] }], ipRisk:{verdict:'PASS',findings:[]}, productUnderstanding: understanding(payload) }) : operation === 'image-text-review' ? chat({ verdict: 'PASS', checks: [], expectedTextChecks: [{ index: 0, present: true, reason: 'Present.' }], noTextVerified: false, issues: [] }) : undefined);
  const plan = await f.ai.imagePlan(f.context,() => {}), ocr = await f.ai.recognizeGeneratedImage(f.context,f.candidate,f.bytes,() => {});
  await assert.rejects(f.ai.reviewGeneratedImage(f.context,plan,ocr,f.candidate,() => {}));
});

test('OCR review must cover every line and cannot cite generated copy as evidence', async t => {
  const f = await fixture(t); f.context.purpose = 'detail';
  const plan = await f.ai.imagePlan(f.context,() => {}), ocr = await f.ai.recognizeGeneratedImage(f.context,f.candidate,f.bytes,() => {});
  if (ocr.output.kind !== 'generated-image-ocr') throw new Error('Wrong OCR type');
  ocr.output.text = 'Silicone'; ocr.output.lines = [{ text: 'Silicone', confidence: 1, box: null }];
  const check = { source: 'summary' as const, index: 0, text: 'Silicone', verdict: 'SUPPORTED' as const, evidenceIds: [f.context.listing.evidence[0].id], reason: 'Material.' };
  const review: ImageTextReviewOutput = { kind: 'image-text-review', candidate: f.candidate, planResultId: plan.id, ocrResultId: ocr.id, verdict: 'NEEDS_CHANGES', checks: [check], expectedTextChecks: [], noTextVerified: false, issues: ['Unexpected words.'], visualReview: 'not_performed' };
  assert.throws(() => assertImageTextReview(review,f.context,plan,ocr,f.candidate));
  review.checks.push({ ...check, source: 'line', evidenceIds: [f.context.listingReviewResultId!] });
  assert.throws(() => assertImageTextReview(review,f.context,plan,ocr,f.candidate));
});

test('minor OCR inflection does not reject factually equivalent planned wording', async t => {
  const f = await fixture(t); f.context.purpose = 'detail';
  const plan = await f.ai.imagePlan(f.context,() => {}), ocr = await f.ai.recognizeGeneratedImage(f.context,f.candidate,f.bytes,() => {});
  const evidenceIds = [f.context.listing.evidence[0].id];
  plan.output = { ...plan.output as Extract<AiResult['output'], {kind:'image-plan'}>, kind: 'image-plan', prompt: 'Show Silicone.', textMode: 'planned', expectedText: [{ text: 'Silicone', evidenceIds }] };
  if (ocr.output.kind !== 'generated-image-ocr') throw new Error('Wrong OCR type');
  ocr.output.text = 'Silicones'; ocr.output.lines = [{ text: 'Silicones', confidence: 1, box: null }];
  const review: ImageTextReviewOutput = { kind: 'image-text-review', candidate: f.candidate, planResultId: plan.id, ocrResultId: ocr.id, verdict: 'PASS', checks: (['summary','line'] as const).map(source => ({ source, index: 0, text: 'Silicones', verdict: 'SUPPORTED', evidenceIds, reason: 'Material.' })), expectedTextChecks: [{ index: 0, present: true, reason: 'Present.' }], noTextVerified: false, issues: [], visualReview: 'not_performed' };
  assert.doesNotThrow(() => assertImageTextReview(review,f.context,plan,ocr,f.candidate));
});
test('new slot OCR tolerates harmless markings and missing cosmetic captions but rejects clear measurement contradictions',async t=>{
  const f=await fixture(t),plan=await f.ai.imagePlan(f.context,()=>{}),ocr=await f.ai.recognizeGeneratedImage(f.context,f.candidate,f.bytes,()=>{});
  f.context.slot={index:1,total:7,provisional:true};
  if(ocr.output.kind!=='generated-image-ocr')throw new Error('Wrong OCR');
  ocr.output.text='blue!';ocr.output.lines=[{text:'blue!',confidence:0.8,box:null}];
  const review:any={kind:'image-text-review',candidate:f.candidate,planResultId:plan.id,ocrResultId:ocr.id,verdict:'PASS',checks:['summary','line'].map(source=>({source,index:0,text:'blue!',verdict:'SUPPORTED',evidenceIds:[f.context.listing.evidence.find(e=>e.name==='Selected SKU specification')!.id],reason:'Same actual color despite punctuation.'})),expectedTextChecks:[],noTextVerified:false,issues:[],visualReview:'not_performed'};
  assert.doesNotThrow(()=>assertImageTextReview(review,f.context,plan,ocr,f.candidate));
  f.context.purpose='detail';f.context.slot.index=2;f.context.listing.evidence.push({id:'measured',name:'Measured diameter',value:'8 cm',meaning:'general',source:'human_confirmed'});
  ocr.output.text='80 mm';ocr.output.lines=[{text:'80 mm',confidence:1,box:null}];
  review.checks.forEach((item:any)=>{item.text='80 mm';item.evidenceIds=['measured'];});
  assert.doesNotThrow(()=>assertImageTextReview(review,f.context,plan,ocr,f.candidate));
  ocr.output.text='80 cm';ocr.output.lines[0].text='80 cm';review.checks.forEach((item:any)=>item.text='80 cm');
  assert.throws(()=>assertImageTextReview(review,f.context,plan,ocr,f.candidate));
});

test('image planning rejects a fabricated fallback dimension in prompt as well as visible text', async t => {
  const f = await fixture(t);
  f.context.slot={index:1,total:7,provisional:true};
  f.respond((operation,payload)=>operation==='image-plan'?chat({kind:'image-plan',prompt:'Show this 5 x 5 x 5 cm product weighing 100 g.',textMode:'none',expectedText:[],ipRisk:{verdict:'PASS',findings:[]},productUnderstanding:understanding(payload)}):undefined);
  await assert.rejects(f.ai.imagePlan(f.context,()=>{}),(error:any)=>error.code==='OUTPUT_INVALID');
});
test('image planning retains observations but never promotes their unverified measurements into rendering',async t=>{
  const f=await fixture(t);f.context.slot={index:1,total:7,provisional:true};
  for(const field of ['summary','uncertainties'] as const){
    f.respond((operation,payload)=>operation==='image-plan'?chat({kind:'image-plan',prompt:'Show the source product.',textMode:'none',expectedText:[],ipRisk:{verdict:'PASS',findings:[]},
      productUnderstanding:{...understanding(payload),[field]:field==='summary'?'A product measuring 5 cm.':['No actual measurements. Use the listing default of 5 cm and 100 g.']}}):undefined);
    const result=await f.ai.imagePlan(f.context,()=>{});if(result.output.kind!=='image-plan')throw Error('Wrong plan');
    assert.ok(JSON.stringify(result.output.productUnderstanding).includes('5 cm'));assert.doesNotMatch(imageGenerationPrompt(result.output),/5 cm|100 g/);
  }
});
test('default-backed weight is removed before independent image-copy review and planning with matching provenance',async t=>{
  const f=await fixture(t),weight=[{value:0.22,unit:'pounds'}];
  const draft=f.amazon.saveDraft({id:f.draft.id,revision:f.draft.revision,attributes:{...f.draft.attributes,item_package_weight:weight,product_description:[{value:'Silicone coaster. Weight 100 g.'}]}});
  const db=openDatabase(f.directory);try{const row=db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(draft.id)!,record=JSON.parse(String(row.record_json));record.draft.businessRules={revision:1,fields:{item_package_weight:{value:weight,reason:'业务默认；缺少实测重量'}},notices:[],quote:null,bundleQuantity:1};db.prepare('UPDATE listing_drafts SET record_json=? WHERE id=?').run(JSON.stringify(record),draft.id);}finally{db.close();}
  const start=f.requests.length,reviewed=await f.listing.reviewCurrentForImages({draftId:draft.id,draftRevision:draft.revision});
  const context:ProductImageContext={...f.context,listing:reviewed.context,currentListingCopy:reviewed.currentListingCopy,listingReviewResultId:reviewed.review.id,slot:{index:1,total:7,provisional:true}};
  await f.ai.imagePlan(context,()=>{});
  assert.equal(JSON.stringify(context.currentListingCopy).includes('100 g'),false);assert.equal(JSON.stringify(f.requests.slice(start).map(request=>request.payload)).includes('100 g'),false);
  assert.equal((f.amazon.getDraft(draft.id).attributes.item_package_weight as any)[0].value,0.22);
});

test('cross-SKU references, candidate byte changes and exhausted budgets make no paid request', async t => {
  const f = await fixture(t), before = f.requests.length;
  const other = structuredClone(f.context); other.referenceAssets[0].variantId = randomUUID();
  await assert.rejects(f.ai.imagePlan(other,() => {}));
  await assert.rejects(f.ai.recognizeGeneratedImage(f.context,{ ...f.candidate,sha256: 'a'.repeat(64) },f.bytes,() => {}));
  f.ai.setUsagePolicy({ providerId: 'deepseek', dailyCallLimit: 0, dailyTokenLimit: null });
  await assert.rejects(f.ai.imagePlan(f.context,() => {})); assert.equal(f.requests.length,before);
});

test('source changes during a paid image plan never produce a reusable result', async t => {
  const f = await fixture(t);
  f.respond(operation => { if (operation === 'image-plan') f.store.saveProduct({ ...saveInput(f.product), description: 'Changed during request.' }); return undefined; });
  await assert.rejects(f.ai.imagePlan(f.context,() => {}));
  assert.equal(f.ai.listResults(f.product.id).some(result => result.output.kind === 'image-plan'),false);
  assert.equal(f.ai.getUsageSummary('deepseek').attempts,1);
});

test('a newer independent rejection supersedes a prior current-copy PASS before image planning', async t => {
  const f = await fixture(t);
  f.respond((operation,payload) => operation === 'listing-current-review' ? chat({ ...currentReview(payload), verdict: 'NEEDS_CHANGES', issues: [{ field: 'item_name', message: 'Confirm product identity.' }] }) : undefined);
  await f.listing.reviewCurrentForImages({ draftId: f.draft.id, draftRevision: f.draft.revision });
  const count = f.requests.length;
  await assert.rejects(f.ai.imagePlan(f.context,() => {}));
  assert.equal(f.requests.length,count);
});

test('cancellation during image planning stops the response from becoming reusable evidence', async t => {
  const f = await fixture(t), controller = new AbortController();
  f.respond(operation => { if (operation === 'image-plan') controller.abort(); return undefined; });
  await assert.rejects(f.ai.imagePlan(f.context,() => {},undefined,controller.signal));
  assert.equal(f.ai.listResults(f.product.id).some(result => result.output.kind === 'image-plan'),false);
  assert.equal(f.ai.getUsageSummary('deepseek').attempts,1);
});

test('a malformed image provider response is an output error and is charged only once', async t => {
  const f = await fixture(t);
  f.respond(operation => operation === 'image-plan' ? chat({ kind: 'image-plan', prompt: 'Plain white.', textMode: 'none', expectedText: [], unexpected: 'reject' }) : undefined);
  await assert.rejects(f.ai.imagePlan(f.context,() => {}), (error: any) => error.code === 'OUTPUT_INVALID');
  assert.equal(f.ai.getUsageSummary('deepseek').attempts,1);
});

test('DeepSeek receives actual SKU image bytes, source identity and product context before writing a plan', async t => {
  const f = await fixture(t), plan = await f.ai.imagePlan(f.context,() => {});
  const request = f.requests.find(item => item.operation === 'image-plan')!;
  assert.ok(Array.isArray(request.body.messages[1].content), 'Planning must be multimodal, not just reference IDs');
  const images = request.body.messages[1].content.filter((part: any) => part.type === 'image_url');
  assert.equal(images.length,f.context.referenceAssets.length);
  assert.deepEqual(Buffer.from(images[0].image_url.url.split(',')[1],'base64'),f.bytes);
  assert.equal(images[0].image_url.detail,'original');
  assert.equal(request.body.model,'deepseek-flash');
  assert.deepEqual(request.payload.referenceImages.map((image: any) => ({assetId:image.assetId,sha256:image.sha256})), f.context.referenceAssets.map(({assetId,sha256})=>({assetId,sha256})));
  assert.equal(request.payload.unverifiedSourceTitle,f.context.listing.unverifiedSourceTitle);
  assert.match((plan.output as any).productUnderstanding.summary,/coaster/);
  assert.ok(!JSON.stringify(plan).includes('data:image/'), 'History stores identities and observations, not duplicated image bodies');
  assert.ok(plan.imageRequestBytes! > f.bytes.length);
});

test('IP source snapshot preserves explicit brand facts and raw SKU names alongside full source evidence',async t=>{
  const f=await fixture(t); await f.ai.imagePlan(f.context,()=>{});
  const payload=f.requests.find(request=>request.operation==='image-plan')!.payload;
  assert.ok(payload.evidence.some((fact:any)=>fact.name==='品牌'&&fact.value==='三丽鸥'));
  assert.equal(payload.unverifiedIpSource.originalSpec,'库洛米 蓝色');
  assert.equal(payload.unverifiedIpSource.normalizedSpec,'Blue');
  assert.equal(payload.unverifiedIpSource.description,f.product.description);
  assert.ok(payload.unverifiedIpSource.facts.some((fact:any)=>fact.name==='品牌'&&fact.value==='三丽鸥'&&fact.state==='source_confirmed'));
  const before=f.requests.length, changed=structuredClone(f.context); changed.ipSource!.facts=changed.ipSource!.facts.filter(fact=>fact.name!=='品牌');
  await assert.rejects(f.ai.imagePlan(changed,()=>{})); assert.equal(f.requests.length,before);
});

test('image planning uses Flash vision with the shared key even when copy generation selects Pro', async t => {
  const f = await fixture(t);
  f.ai.saveFunctionSettings({id:'deepseek',model:'deepseek-v4-pro',enabled:true});
  const plan = await f.ai.imagePlan(f.context,() => {});
  assert.equal(f.requests.at(-1)!.body.model,'deepseek-flash');
  assert.equal(plan.model,'deepseek-flash');
  assert.equal(f.ai.getProfile('deepseek').model,'deepseek-v4-pro');
});

test('missing or foreign visual understanding cannot become a reusable image plan', async t => {
  const f = await fixture(t);
  f.respond(operation=>operation==='image-plan'?chat({kind:'image-plan',prompt:'White background.',textMode:'none',expectedText:[],ipRisk:{verdict:'PASS',findings:[]}}):undefined);
  await assert.rejects(f.ai.imagePlan(f.context,() => {}));
  f.respond(operation=>operation==='image-plan'?chat({kind:'image-plan',prompt:'White background.',textMode:'none',expectedText:[],ipRisk:{verdict:'PASS',findings:[]},productUnderstanding:{summary:'A coaster.',referenceAssetIds:[randomUUID()],uncertainties:[],sufficient:true}}):undefined);
  await assert.rejects(f.ai.imagePlan(f.context,() => {}));
  assert.equal(f.ai.listResults(f.product.id).some(result=>result.output.kind==='image-plan'),false);
});

test('missing or modified source bytes stop vision planning before a paid request', async t => {
  const f = await fixture(t), before=f.requests.length;
  const changed=Buffer.from(f.bytes);changed[32]=1;
  writeFileSync(join(f.directory,f.store.getAssetRecord(f.product.assets[0].id)!.originalPath),changed);
  await assert.rejects(f.ai.imagePlan(f.context,() => {}));
  assert.equal(f.requests.length,before);
});

test('two distinct references retain their byte order and reversed understanding IDs are rejected', async t=>{
  const f=await fixture(t,true); await f.ai.imagePlan(f.context,()=>{});
  const images=f.requests.at(-1)!.body.messages[1].content.filter((part:any)=>part.type==='image_url');
  assert.equal(images.length,2);
  const expected=f.context.referenceAssets.map(ref=>readFileSync(join(f.directory,f.store.getAssetRecord(ref.assetId)!.originalPath)));
  assert.notDeepEqual(expected[0],expected[1]);
  assert.deepEqual(images.map((part:any)=>Buffer.from(part.image_url.url.split(',')[1],'base64')),expected);
  f.respond((operation,payload)=>operation==='image-plan'?chat({kind:'image-plan',prompt:'Preserve this product.',textMode:'none',expectedText:[],ipRisk:{verdict:'PASS',findings:[]},productUnderstanding:{...understanding(payload),referenceAssetIds:payload.referenceImages.map((image:any)=>image.assetId).reverse()}}):undefined);
  await assert.rejects(f.ai.imagePlan(f.context,()=>{}));
});

for(const legacyVersion of ['product-image/v1','product-image/vision-v2'] as const)test(`legacy ${legacyVersion} plans and completed provenance survive backup/restore but cannot be reused`,async t=>{
  const f=await fixture(t),generated=Buffer.from(f.bytes);generated[32]=23;f.candidate.sha256=createHash('sha256').update(generated).digest('hex');
  const plan=await f.ai.imagePlan(f.context,()=>{}), ocr=await f.ai.recognizeGeneratedImage(f.context,f.candidate,generated,()=>{}), review=await f.ai.reviewGeneratedImage(f.context,plan,ocr,f.candidate,()=>{});
  const legacyContext={...f.context,policyVersion:legacyVersion}; delete legacyContext.ipSource;
  const contextSha256=listingFingerprint(legacyContext), runId=randomUUID();
  const db=openDatabase(f.directory);
  try {
    for(const original of [plan,ocr,review]) {
      const legacy=structuredClone(original); legacy.imageContext=legacyContext; legacy.sourceSha256=contextSha256;
      if(legacy.output.kind==='image-plan') {
        if(legacyVersion==='product-image/v1')delete legacy.output.productUnderstanding;
        delete legacy.output.ipRisk; legacy.model=legacyVersion==='product-image/v1'?'deepseek-v4-pro':'deepseek-flash';
        db.prepare("UPDATE ai_calls SET record_json=json_set(record_json,'$.model',?) WHERE id=?").run(legacy.model,legacy.callId);
      }
      markLiteralLegacyCall(db,legacy);
      assert.deepEqual(validateAiResult(legacy),legacy);
      db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify(legacy),legacy.id);
    }
    const generatedId=randomUUID(),path=`assets/${generatedId}.png`;writeFileSync(join(f.directory,path),generated);
    db.prepare("INSERT INTO assets SELECT ?,product_id,file_name,'gallery',mime_type,width,height,byte_size,?,?,?,created_at FROM assets WHERE id=?").run(generatedId,path,path,f.candidate.sha256,f.product.assets[0].id);
    const run={id:runId,draftId:f.draft.id,productId:f.product.id,productRevision:f.product.revision,variantId:f.product.variants[0].id,sku:f.draft.sku,status:'COMPLETED',stage:'complete',attempt:1,maxAttempts:2,contextSha256,draftSha256:imageWorkflowDraftStamp(f.draft),referenceAssets:legacyContext.referenceAssets.map(ref=>({id:ref.assetId,sha256:ref.sha256})),planResultIds:[plan.id],candidateIds:[f.candidate.id],ocrResultIds:[ocr.id],reviewResultIds:[review.id],approvedAssetId:generatedId,approvedSha256:f.candidate.sha256,createdAt:plan.createdAt,updatedAt:review.createdAt,error:null};
    db.prepare('INSERT INTO image_workflow_runs VALUES(?,?)').run(run.id,JSON.stringify(run));
  } finally {db.close();}
  const file=join(f.directory,'legacy.htcbackup'), target=join(f.directory,'restored');
  await createWorkspaceBackup(f.directory,file,'legacy visual provenance passphrase');
  await commitWorkspaceRestore(target,await prepareWorkspaceRestore(target,file,'legacy visual provenance passphrase'));
  const restored=openDatabase(target);
  try {
    const record=validateAiResult(JSON.parse(String(restored.prepare('SELECT record_json FROM ai_results WHERE id=?').get(plan.id)!.record_json)));
    assert.equal(record.model,legacyVersion==='product-image/v1'?'deepseek-v4-pro':'deepseek-flash'); assert.equal(record.imageContext!.policyVersion,legacyVersion);
    assert.equal(Boolean((record.output as any).productUnderstanding),legacyVersion!=='product-image/v1');
    assert.equal(workflowRuns(restored,f.draft.id)[0].id,runId);
    assert.throws(()=>approvedWorkflowAsset(restored,f.draft,f.product),/旧版流程/);
  } finally {restored.close();}
});

test('image-plan accepts only the known json_object envelope marker and keeps raw rejection evidence', async t => {
  const f=await fixture(t);
  const {planProductImage}=await import('../src/main/ai/image-adapters.ts');
  let extra:object={type:'json_object'}, raw:any;
  const adapter={fetch:async()=>chat({kind:'image-plan',prompt:'Photograph the source product without added text.',textMode:'none',expectedText:[],productUnderstanding:{summary:'A blue coaster.',referenceAssetIds:f.context.referenceAssets.map(a=>a.assetId),uncertainties:[],sufficient:true},ipRisk:{verdict:'PASS',findings:[]},...extra}),now:()=>new Date(),nonce:randomUUID,maxResponseBytes:200000,onUntrustedOutput:(value:unknown)=>{raw=value;}};
  const invoke=()=>planProductImage(f.context,undefined,'deepseek-flash',{apiKey:'fixture-key'},new AbortController().signal,adapter,f.context.referenceAssets.map(a=>({...a,mimeType:'image/png',width:256,height:256,bytes:f.bytes})));
  const result=await invoke();
  assert.equal('type' in result.output,false);
  assert.equal(raw.type,'json_object');
  for(extra of [{type:'json_schema'},{type:'json_object',unexpected:'must remain rejected'},{type:'json_object',textMode:'planned'}]) {
    await assert.rejects(invoke(),(error:unknown)=>error instanceof AiError&&error.code==='OUTPUT_INVALID');
    for(const [key,value] of Object.entries(extra))assert.equal(raw[key],value);
  }
});

test('copy-only repairs reuse exact seven-image approvals without paid calls and preserve backup provenance',async t=>{
  const f=await legacyFixture(t);let imageCount=0;
  f.respond(operation=>operation==='ip-upload'?new Response(null,{status:200}):undefined);
  const generation=new ImageGenerationService(f.directory,f.store,mockStorage,{decodePreview:bytes=>bytes,fetch:async()=>{const bytes=Buffer.from(f.bytes);bytes[32]=++imageCount;return Response.json({data:[{b64_json:bytes.toString('base64')}]});}});
  generation.saveConnection({model:'openai/gpt-image-2.5-sunburst',enabled:true,apiKey:'test-only'});
  const workflow=new ImageWorkflowService(f.directory,f.store,f.amazon,f.ai,generation,{listing:{currentContext:(...args)=>f.listing.currentContext(...args),complete:async()=>({draft:f.amazon.getDraft(f.draft.id),aiCalls:0,previewAttempts:0,remaining:[]}),reviewCurrentForImages:(input,signal)=>f.listing.reviewCurrentForImages(input,signal)}});
  f.cleanup(async()=>{await workflow.close();await generation.close();});
  const first=await workflow.complete({draftId:f.draft.id,draftRevision:f.draft.revision});assert.equal(first.workflow.status,'COMPLETED',first.workflow.error??'');
  const old=f.amazon.getDraft(f.draft.id),changed=f.amazon.saveDraft({id:old.id,revision:old.revision,attributes:{...old.attributes,item_name:[{value:'Blue Round Silicone Coaster'}]}}),before=f.requests.length;
  const reused=await workflow.recheck({draftId:changed.id,draftRevision:changed.revision,sourceWorkflowId:first.workflow.id});
  assert.equal(f.requests.length,before);assert.equal(imageCount,7);assert.equal(reused.aiCalls,0);
  assert.equal(reused.workflow.approvalReuse?.sourceRunId,first.workflow.id);assert.deepEqual(reused.workflow.slots,first.workflow.slots);assert.deepEqual(reused.workflow.imageContext,first.workflow.imageContext);
  const frozenPair=structuredClone([first.workflow,reused.workflow]);
  const currentListing=new ListingAiService(f.store,f.amazon,f.ai);
  (workflow as any).listing.currentContext=(...args:Parameters<ListingAiService['currentContext']>)=>currentListing.currentContext(...args);
  const checked=await workflow.recheck({draftId:changed.id,draftRevision:changed.revision,sourceWorkflowId:reused.workflow.id});
  assert.equal(checked.workflow.id,reused.workflow.id);assert.equal(f.requests.length,before);
  const proofDb=openDatabase(f.directory);try{const runs=workflowRuns(proofDb,f.draft.id);assert.deepEqual([runs.find(r=>r.id===first.workflow.id),runs.find(r=>r.id===reused.workflow.id)],frozenPair);}finally{proofDb.close();}
  const backup=join(f.directory,'approval-reuse.htcbackup'),target=join(f.directory,'reuse-restored');await createWorkspaceBackup(f.directory,backup,'reused image approval test passphrase');
  await commitWorkspaceRestore(target,await prepareWorkspaceRestore(target,backup,'reused image approval test passphrase'));
  const restored=openDatabase(target);try{assert.equal(workflowRuns(restored,f.draft.id)[0].approvalReuse?.sourceRunId,first.workflow.id);}finally{restored.close();}
  const db=openDatabase(f.directory);try{const tampered=structuredClone(reused.workflow);tampered.approvalReuse!.draftSnapshot='{}';db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(JSON.stringify(tampered),tampered.id);await assert.rejects(createWorkspaceBackup(f.directory,join(f.directory,'tampered.htcbackup'),'reused image approval test passphrase'));db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(JSON.stringify(reused.workflow),reused.workflow.id);}finally{db.close();}
  const again=await workflow.recheck({draftId:changed.id,draftRevision:changed.revision,sourceWorkflowId:reused.workflow.id});assert.equal(again.workflow.id,reused.workflow.id);assert.equal(f.requests.length,before);
  const originalGet=f.store.getAssetRecord.bind(f.store);let mutateOnce=true;
  f.store.getAssetRecord=(id:string)=>{if(mutateOnce&&id===first.workflow.approvedAssetId){mutateOnce=false;const current=f.amazon.getDraft(changed.id);f.amazon.saveDraft({id:current.id,revision:current.revision,attributes:{...current.attributes,item_name:[{value:'Blue Silicone Coaster'}]}});}return originalGet(id);};
  await assert.rejects(workflow.recheck({draftId:changed.id,draftRevision:changed.revision,sourceWorkflowId:first.workflow.id}),(error:unknown)=>error instanceof AiError&&error.code==='SOURCE_CHANGED');
  f.store.getAssetRecord=originalGet;assert.equal(f.requests.length,before);
  const current=f.amazon.getDraft(changed.id),asset=originalGet(first.workflow.approvedAssetId!)!;writeFileSync(join(f.directory,asset.originalPath),Buffer.from('modified image bytes'));
  await assert.rejects(workflow.recheck({draftId:current.id,draftRevision:current.revision,sourceWorkflowId:first.workflow.id}),(error:unknown)=>error instanceof AiError&&error.code==='SOURCE_CHANGED');assert.equal(f.requests.length,before);
});

test('interrupted IP rechecks reuse old approvals without calls but never override a newer IP rejection',async t=>{
  const f=await fixture(t);let images=0;
  f.respond(operation=>operation==='ip-upload'?new Response(null,{status:200}):undefined);
  const generation=new ImageGenerationService(f.directory,f.store,mockStorage,{decodePreview:bytes=>bytes,fetch:async()=>{const bytes=Buffer.from(f.bytes);bytes[32]=++images;return Response.json({data:[{b64_json:bytes.toString('base64')}]});}});
  generation.saveConnection({model:'openai/gpt-image-2.5-sunburst',enabled:true,apiKey:'fixture-image-key'});
  const workflow=new ImageWorkflowService(f.directory,f.store,f.amazon,f.ai,generation,{listing:{currentContext:(...args)=>f.listing.currentContext(...args),complete:async()=>({draft:f.amazon.getDraft(f.draft.id),aiCalls:0,previewAttempts:0,remaining:[]}),reviewCurrentForImages:(input,signal)=>f.listing.reviewCurrentForImages(input,signal)}});
  f.cleanup(async()=>{await workflow.close();await generation.close();});
  const first=await workflow.complete({draftId:f.draft.id,draftRevision:f.draft.revision});assert.equal(first.workflow.status,'COMPLETED');
  const old=f.amazon.getDraft(f.draft.id),changed=f.amazon.saveDraft({id:old.id,revision:old.revision,attributes:{...old.attributes,item_name:[{value:'Blue Round Silicone Coaster'}]}});
  const request={draftId:changed.id,draftRevision:changed.revision,sourceWorkflowId:first.workflow.id};
  const oldVersion=(workflow as unknown as {recheckWithFreshEvidence(input:unknown):ReturnType<ImageWorkflowService['recheck']>});
  f.respond(operation=>{if(operation==='ImageModeration')throw new Error('fixture network outage');return operation==='ip-upload'?new Response(null,{status:200}):undefined;});
  const interrupted=await oldVersion.recheckWithFreshEvidence(request);assert.equal(interrupted.workflow.status,'FAILED');assert.equal(interrupted.workflow.stage,'ip-check');
  f.respond(operation=>operation==='ip-upload'?new Response(null,{status:200}):undefined);
  const before=f.requests.length,resumed=await workflow.recheck(request);assert.equal(resumed.workflow.approvalReuse?.sourceRunId,first.workflow.id);assert.equal(f.requests.length,before);assert.equal(images,7);
  await createWorkspaceBackup(f.directory,join(f.directory,'interrupted-ip-reused.htcbackup'),'interrupted IP image reuse backup passphrase');
  f.respond((operation,payload)=>operation==='ImageModeration'?Response.json({Code:200,RequestId:'fixture-new-ip-risk',Data:{DataId:payload.dataId,RiskLevel:'high',Result:[{Label:'tm_goods',Confidence:99,Description:'Distinctive brand detected'}]}}):operation==='ip-upload'?new Response(null,{status:200}):undefined);
  const rejected=await oldVersion.recheckWithFreshEvidence(request);assert.equal(rejected.workflow.slots![0].status,'BLOCKED');
  const denied=await workflow.recheck(request);assert.equal(denied.workflow.approvalReuse,undefined);assert.notEqual(denied.workflow.status,'COMPLETED');assert.equal(images,7);
});

for(const code of ['EMPTY_PROMPT','UNSUPPORTED_MEASUREMENT','SOURCE_OBSERVATION_INSUFFICIENT'] as const)test('actionable image reason '+code+' persists exact set-plan call before any generation and survives restart',async t=>{
 const f=await fixture(t),{workflow,posts}=productionWorkflow(f);
 (workflow as any).listing.complete=async()=>({draft:f.amazon.getDraft(f.draft.id),aiCalls:0,previewAttempts:0,remaining:[]});
 f.respond((operation,payload)=>operation==='image-plan'?chat({kind:'image-plan',setPlan:sceneSet(),prompt:code==='UNSUPPORTED_MEASUREMENT'?'Show a 999 cm product.':'',textMode:'none',expectedText:[],ipRisk:{verdict:'PASS',findings:[]},productUnderstanding:{...understanding(payload),sufficient:code!=='SOURCE_OBSERVATION_INSUFFICIENT',uncertainties:code==='SOURCE_OBSERVATION_INSUFFICIENT'?['https://secret.invalid/?token=secret']:[]}}):undefined);
 const result=await workflow.complete({draftId:f.draft.id,draftRevision:f.draft.revision});
 assert.equal(result.workflow.rejection?.code,code);assert.equal(result.workflow.rejection?.slot,code==='EMPTY_PROMPT'?1:0);assert.equal(result.workflow.rejection?.stage,'planning');assert.equal(posts(),0);assert.equal(result.workflow.slots?.reduce((n,slot)=>n+slot.attempts.length,0),code==='EMPTY_PROMPT'?1:0);
 const detail=result.workflow.rejection!,call=f.ai.getCall(detail.callId)!;assert.equal(call.presentationContext?.draftId,f.draft.id);assert.doesNotMatch(result.workflow.error??'',/secret|https/);
 if(code==='SOURCE_OBSERVATION_INSUFFICIENT'){assert.equal(call.status,'SUCCEEDED');assert.ok(detail.resultId);assert.equal(result.workflow.setPlanResultId,undefined);}else{assert.equal(call.rejection?.code,code);assert.equal(detail.resultId,null);}
 const before=f.requests.length;await workflow.close();
 const db=openDatabase(f.directory);try{const {workflowRuns}=await import('../src/main/image-workflow/records.ts');assert.deepEqual(workflowRuns(db,f.draft.id)[0].rejection,detail);}finally{db.close();}
 assert.equal(f.requests.length,before);assert.equal(posts(),0);
 const backup=join(f.directory,'actionable-image.htcbackup');await createWorkspaceBackup(f.directory,backup,'synthetic image reason passphrase');
 if(code!=='SOURCE_OBSERVATION_INSUFFICIENT'){
  assert.equal(call.presentationContext?.workflowId,result.workflow.id);
  const db=openDatabase(f.directory),rawCall=String(db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(call.id)!.record_json),rawRun=String(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(result.workflow.id)!.record_json);
  try{
   const foreignHash='b'.repeat(64),wrongCall={...call,presentationContext:{...call.presentationContext,sourceSha256:foreignHash}},wrongRun={...result.workflow,rejection:{...detail,contextSha256:foreignHash}};
   db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(wrongCall),call.id);db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(JSON.stringify(wrongRun),result.workflow.id);
   assert.throws(()=>workflowRuns(db,f.draft.id));await assert.rejects(createWorkspaceBackup(f.directory,join(f.directory,'wrong-context.htcbackup'),'synthetic image reason passphrase'));
   db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(rawRun,result.workflow.id);
   db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify({...call,presentationContext:{...call.presentationContext,workflowId:randomUUID()}}),call.id);
   assert.throws(()=>workflowRuns(db,f.draft.id));await assert.rejects(createWorkspaceBackup(f.directory,join(f.directory,'wrong-workflow.htcbackup'),'synthetic image reason passphrase'));
  }finally{db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(rawCall,call.id);db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(rawRun,result.workflow.id);db.close();}
 }
});

test('Haul rules reuse seven frozen approvals and hosted URLs survive paused execution without new generation',async t=>{
  const f=await fixture(t,false,false,false,true),p=(f.amazon as any).persistence,r=p.record(f.draft.id),market=r.draft.marketplaceId;
  r.draft.listingProgram='haul';r.draft.attributes.is_value_stores_item=[{value:true,marketplace_id:market}];r.draft.attributes.purchasable_offer=[{audience:'BZR',currency:'USD',marketplace_id:market,our_price:[{schedule:[{value_with_tax:2.5}]}]}];r.draft.attributes.merchant_suggested_asin=[];
  for(const field of ['item_name','material','color'])r.draft.attributes[field][0].marketplace_id=market;
  Object.assign(r.draft.schema.schema.properties,{is_value_stores_item:{type:'array',items:{type:'object',properties:{value:{type:'boolean'},marketplace_id:{type:'string'}},required:['value']}},manufacturer:{type:'array',items:{type:'object',properties:{value:{type:'string'},marketplace_id:{type:'string'}},required:['value']}},item_package_weight:{type:'array',items:{type:'object',properties:{value:{type:'number'},unit:{enum:['pounds']},marketplace_id:{type:'string'}},required:['value','unit']}}});
  r.draft.schema.checksum=createHash('md5').update(JSON.stringify(r.draft.schema.schema)).digest('base64');p.putRecord(r);f.amazon.getSchema=async()=>structuredClone(r.draft.schema);
  const measurement={type:'object',properties:{value:{type:'number'},unit:{enum:['inches']}},required:['value','unit']};Object.assign(r.draft.schema.schema.properties,{item_package_dimensions:{type:'array',items:{type:'object',properties:{length:measurement,width:measurement,height:measurement,marketplace_id:{type:'string'}},required:['length','width','height']}},item_package_weight:{type:'array',items:{type:'object',properties:{value:{type:'number'},unit:{enum:['pounds']},marketplace_id:{type:'string'}},required:['value','unit']}}});r.draft.schema.checksum=createHash('md5').update(JSON.stringify(r.draft.schema.schema)).digest('base64');p.putRecord(r);
  f.draft=f.amazon.applyBusinessDefaults(f.amazon.getDraft(f.draft.id));r.draft=f.draft;f.amazon.assertPricingForPaid(f.draft.id);
  let images=0;f.respond(operation=>operation==='ip-upload'?new Response(null,{status:200}):undefined);
  const generation=new ImageGenerationService(f.directory,f.store,mockStorage,{decodePreview:bytes=>bytes,fetch:async()=>{const bytes=Buffer.from(f.bytes);bytes[32]=++images;return Response.json({data:[{b64_json:bytes.toString('base64')}]});}});generation.saveConnection({model:'openai/gpt-image-2.5-sunburst',enabled:true,apiKey:'synthetic-only'});
  const workflow=new ImageWorkflowService(f.directory,f.store,f.amazon,f.ai,generation,{listing:{currentContext:(...args)=>f.listing.currentContext(...args),complete:async()=>({draft:f.amazon.getDraft(f.draft.id),aiCalls:0,previewAttempts:0,remaining:[]}),reviewCurrentForImages:(input,signal)=>f.listing.reviewCurrentForImages(input,signal)}});
  f.cleanup(async()=>{await workflow.close();await generation.close();});
  const first=await workflow.complete({draftId:f.draft.id,draftRevision:r.draft.revision});assert.equal(first.workflow.status,'COMPLETED',first.workflow.error??'');const frozen=p.db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(first.workflow.id).record_json,calls=f.requests.length;
  const fixed=f.amazon.applyBusinessDefaults(f.amazon.getDraft(f.draft.id));assert.equal((fixed.attributes.item_package_weight as any)[0].value,.22);
  const reused=await workflow.complete({draftId:fixed.id,draftRevision:fixed.revision});
  assert.ok(reused.workflow.id===first.workflow.id||reused.workflow.approvalReuse?.sourceRunId===first.workflow.id,reused.workflow.error??'');assert.equal(f.requests.length,calls);assert.equal(images,7);assert.deepEqual(reused.workflow.slots,first.workflow.slots);
  const db=openDatabase(f.directory);try{assert.equal(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(first.workflow.id)!.record_json,frozen);}finally{db.close();}
  const {ExecutionService}=await import('../src/main/execution/service.ts');const remote=new Map<string,number>();let uploads=0,paused=false,taskId='',execution:InstanceType<typeof ExecutionService>;
  const hosting=new HostingService(f.directory,f.store,mockStorage,{transport:{async size(_p,_c,path){return remote.get(path)??null;},async upload(_p,_c,path,data){uploads++;remote.set(path,data.length);if(uploads===3&&!paused){paused=true;execution.pause(taskId);}return data.length;},async close(){}},probe:async()=>{}});
  hosting.importProfile({id:'alpha',host:'fixture.example.test',port:2121,secure:false,username:'fixture-user',password:'synthetic-password',remoteRoot:'/',publicBaseUrl:'https://htc.185858.xyz/AAA/'});hosting.setEnabled({id:'alpha',enabled:true});
  execution=new ExecutionService(f.directory,f.store,f.amazon,hosting);f.cleanup(async()=>{await execution.close();await hosting.close();});
  const task=execution.create({draftIds:[fixed.id],profileId:'alpha'});taskId=task.id;execution.startAuthorized(execution.prepareStart(task.id));await execution.waitForIdle();assert.equal(uploads,3);assert.equal(execution.get(task.id).status,'PAUSED');
  await execution.close();execution=new ExecutionService(f.directory,f.store,f.amazon,hosting);execution.startAuthorized(execution.prepareStart(task.id));await execution.waitForIdle();
  const done=execution.get(task.id),item=done.items[0];assert.equal(uploads,7);assert.equal(images,7);assert.equal(f.requests.length,calls);assert.equal(item.uploads.length,7);assert.equal(item.steps.find(s=>s.name==='images')!.status,'DONE');
  const actual=f.amazon.getDraft(fixed.id);for(const [i,asset] of item.assets.entries()){const field=i===0?'main_product_image_locator':`other_product_image_locator_${i}`,url=item.uploads.find(u=>u.assetId===asset.id)!.publicUrl;assert.deepEqual(actual.attributes[field],[{marketplace_id:market,media_location:url}]);}
  const preview=p.record(fixed.id).exchanges.find((e:any)=>e.operation==='preview');assert.ok(preview,'hosted attributes reached a validation preview');assert.deepEqual(preview.request.attributes,actual.attributes);
});

for(const unknown of [false,true])test(`Haul partial seven-image continuation preserves slots and ${unknown?'unknown request':'attempt budget'} after business defaults`,async t=>{
  const f=await fixture(t,false,false,false,true),p=(f.amazon as any).persistence,r=p.record(f.draft.id),market=r.draft.marketplaceId;
  r.draft.listingProgram='haul';r.draft.attributes.is_value_stores_item=[{value:true,marketplace_id:market}];r.draft.attributes.purchasable_offer=[{audience:'BZR',currency:'USD',marketplace_id:market,our_price:[{schedule:[{value_with_tax:2.5}]}]}];
  (r.draft.schema.schema.properties as any).is_value_stores_item={type:'array',items:{type:'object',properties:{value:{type:'boolean'},marketplace_id:{type:'string'}},required:['value']}};p.putRecord(r);f.amazon.getSchema=async()=>structuredClone(r.draft.schema);
  const measurement={type:'object',properties:{value:{type:'number'},unit:{enum:['inches']}},required:['value','unit']};Object.assign(r.draft.schema.schema.properties,{item_package_dimensions:{type:'array',items:{type:'object',properties:{length:measurement,width:measurement,height:measurement,marketplace_id:{type:'string'}},required:['length','width','height']}},item_package_weight:{type:'array',items:{type:'object',properties:{value:{type:'number'},unit:{enum:['pounds']},marketplace_id:{type:'string'}},required:['value','unit']}}});r.draft.schema.checksum=createHash('md5').update(JSON.stringify(r.draft.schema.schema)).digest('base64');p.putRecord(r);
  f.draft=f.amazon.applyBusinessDefaults(f.amazon.getDraft(f.draft.id));r.draft=f.draft;f.amazon.assertPricingForPaid(f.draft.id);
  let images=0;f.respond(operation=>operation==='ip-upload'?new Response(null,{status:200}):undefined);
  const generation=new ImageGenerationService(f.directory,f.store,mockStorage,{decodePreview:bytes=>bytes,fetch:async()=>{const bytes=Buffer.from(f.bytes);bytes[32]=++images;if(unknown&&images===3)throw Error('synthetic lost response');return Response.json({data:[{b64_json:bytes.toString('base64')}]});}});generation.saveConnection({model:'openai/gpt-image-2.5-sunburst',enabled:true,apiKey:'synthetic-only'});
  const listing={currentContext:(...args:Parameters<ListingAiService['currentContext']>)=>f.listing.currentContext(...args),complete:async()=>({draft:f.amazon.getDraft(f.draft.id),aiCalls:0,previewAttempts:0,remaining:[]}),reviewCurrentForImages:(input:any,signal?:AbortSignal)=>f.listing.reviewCurrentForImages(input,signal)};
  let workflow=new ImageWorkflowService(f.directory,f.store,f.amazon,f.ai,generation,{listing});f.cleanup(async()=>{await workflow.close();await generation.close();});
  const plan=f.ai.imagePlan.bind(f.ai);let interrupted=false;f.ai.imagePlan=async(...args:Parameters<AiService['imagePlan']>)=>{if(!unknown&&args[0].slot?.index===3&&!interrupted){interrupted=true;throw new AiError('PROVIDER_ERROR');}return plan(...args);};
  const first=await workflow.complete({draftId:f.draft.id,draftRevision:r.draft.revision});assert.equal(first.workflow.slots!.filter(s=>s.status==='PASSED').length,2);const frozen=structuredClone(first.workflow.slots!.slice(0,2)),context=structuredClone(first.workflow.imageContext),attempt=first.workflow.slots![2].attempts[0];
  const fixed=f.amazon.applyBusinessDefaults(f.amazon.getDraft(f.draft.id));
  f.amazon.assertPricingForPaid(fixed.id);
  await workflow.close();workflow=new ImageWorkflowService(f.directory,f.store,f.amazon,f.ai,generation,{listing});
  const resumed=await workflow.complete({draftId:fixed.id,draftRevision:fixed.revision});assert.equal(resumed.workflow.status,unknown?'BLOCKED':'COMPLETED',resumed.workflow.error??'');if(unknown)assert.equal(resumed.workflow.slots![2].attempts[0].state,'UNKNOWN');assert.equal(resumed.workflow.id,first.workflow.id);assert.deepEqual(resumed.workflow.slots!.slice(0,2),frozen);assert.deepEqual(resumed.workflow.imageContext,context);assert.equal(resumed.workflow.slots![2].attempts[0].requestId,attempt.requestId);assert.equal(images,unknown?3:7);
  await createWorkspaceBackup(f.directory,join(f.directory,'partial-rule-reuse.htcbackup'),'synthetic partial rules backup');
});

test('real image owner retains one unresolved generation attempt through encrypted backup',async t=>{
 const f=await fixture(t);let posts=0;
 f.respond(operation=>operation==='ip-upload'?new Response(null,{status:200}):undefined);
 const generation=new ImageGenerationService(f.directory,f.store,mockStorage,{decodePreview:bytes=>bytes,fetch:async()=>{posts++;throw Error('synthetic lost response');}});
 generation.saveConnection({model:'openai/gpt-image-2.5-sunburst',enabled:true,apiKey:'synthetic-only'});
 const workflow=new ImageWorkflowService(f.directory,f.store,f.amazon,f.ai,generation,{listing:{currentContext:(...args)=>f.listing.currentContext(...args),complete:async()=>({draft:f.draft,aiCalls:0,previewAttempts:0,remaining:[]}),reviewCurrentForImages:(input,signal)=>f.listing.reviewCurrentForImages(input,signal)}});
 f.cleanup(async()=>{await workflow.close();await generation.close();});
 for(let n=0;n<4;n++)await workflow.complete({draftId:f.draft.id,draftRevision:f.draft.revision});
 const run=workflow.getProgress(f.draft.id)!;assert.equal(posts,1);assert.equal(run.slots![0].attempts.length,1);
 const file=join(f.directory,'unknown-three.htcbackup');await createWorkspaceBackup(f.directory,file,'synthetic unknown image retry');
 const prepared=await prepareWorkspaceRestore(f.directory,file,'synthetic unknown image retry'),db=openDatabase(prepared.stagingDirectory);
 try{const saved=JSON.parse(String(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(run.id)!.record_json));assert.equal(saved.slots[0].attempts.length,1);assert.deepEqual(saved.slots[0].attempts.map((a:any)=>a.requestId),run.slots![0].attempts.map(a=>a.requestId));}finally{db.close();}
});

test('empty seven-slot source refusal keeps an attributable result and no executable blueprint',async t=>{
 const f=await fixture(t),{workflow,posts}=productionWorkflow(f);
 (workflow as any).listing.complete=async()=>({draft:f.amazon.getDraft(f.draft.id),aiCalls:0,previewAttempts:0,remaining:[]});
 f.respond((operation,payload)=>operation==='image-plan'?chat({kind:'image-plan',setPlan:{...sceneSet(),slots:sceneSet().slots.map(s=>({...s,prompt:'',scene:''}))},prompt:'',textMode:'none',expectedText:[],ipRisk:{verdict:'PASS',findings:[]},productUnderstanding:{...understanding(payload),sufficient:false,uncertainties:['The selected product is not visible.']}}):undefined);
 const before=f.requests.length,result=await workflow.complete({draftId:f.draft.id,draftRevision:f.draft.revision});
 assert.equal(result.aiCalls,f.requests.length-before);assert.equal(result.workflow.rejection?.code,'SOURCE_OBSERVATION_INSUFFICIENT');assert.equal(posts(),0);assert.equal(result.workflow.setPlan,undefined);
 const saved=f.ai.getResult(result.workflow.rejection!.resultId!)!;assert.equal(saved.output.kind,'image-plan');assert.equal((saved.output as any).setPlan.slots[0].prompt,'');assert.equal(f.ai.getCall(saved.callId)!.status,'SUCCEEDED');await workflow.close();
});

test('locally recovered image plan keeps failed paid history and reuses exact saved response without another POST',async t=>{
 const f=await fixture(t),original=await f.ai.imagePlan(f.context,()=>{}),raw:any=structuredClone(original.output);
 for(const key of ['referenceAssetIds','uncertainties','sufficient']){raw[key]=raw.productUnderstanding[key];delete raw.productUnderstanding[key];}
 const call={...f.ai.getCall(original.callId)!,status:'FAILED' as const,errorCode:'OUTPUT_INVALID' as const,responseReceived:true as const};
 const db=openDatabase(f.directory);try{db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(call),call.id);db.prepare('DELETE FROM ai_results WHERE id=?').run(original.id);}finally{db.close();}
 const {recordInvalidAiOutput}=await import('../src/main/ai/output-diagnostics.ts');recordInvalidAiOutput(f.directory,{call,operation:'image-plan',createdAt:call.finishedAt!,rejectionStage:'operation-output-validation',output:raw});
 const before=f.requests.length,result=await f.ai.imagePlan(f.context,()=>{});
 assert.equal(f.requests.length,before);assert.equal(result.callId,call.id);assert.deepEqual(f.ai.getCall(call.id),call);assert.deepEqual(result.output,original.output);assert.deepEqual(result.imagePlanRecovery?.rawOutput,raw);assert.equal(result.imageRequestBytes,undefined);
 assert.deepEqual(f.ai.getResult(result.id),result);assert.equal((await f.ai.imagePlan(f.context,()=>{})).id,result.id);assert.equal(f.requests.length,before);
 assert.equal(await f.ai.recoverImagePlan(call.id,{...f.context,referenceAssets:[{...f.context.referenceAssets[0],assetId:randomUUID()}]},()=>{}),undefined);
 const {resultHasOwner}=await import('../src/main/ai/result-owner.ts');assert.equal(resultHasOwner(result,{...call,presentationContext:{...call.presentationContext!,slot:1}}),false);assert.equal(resultHasOwner(result,{...call,presentationContext:{...call.presentationContext!,variantId:randomUUID()}}),false);
 const diagnosticNames=(await import('node:fs')).readdirSync(join(f.directory,'ai-diagnostics'));const retained=JSON.parse(readFileSync(join(f.directory,'ai-diagnostics',diagnosticNames[0]),'utf8'));assert.deepEqual(retained.output,raw);
 const corrupted=structuredClone(result);(corrupted.output as any).prompt='Changed after local recovery';assert.throws(()=>validateAiResult(corrupted));
});

test('image plan schema failure retains exact safe JSON with a fixed diagnostic reason',async t=>{
 const f=await fixture(t);f.respond(operation=>operation==='image-plan'?chat({kind:'image-plan',unexpected:true}):undefined);
 await assert.rejects(f.ai.imagePlan(f.context,()=>{}));const {readdirSync}=await import('node:fs');
 const files=readdirSync(join(f.directory,'ai-diagnostics')).map(name=>JSON.parse(readFileSync(join(f.directory,'ai-diagnostics',name),'utf8')));
 assert.equal(files.at(-1).rejectionReason,'IMAGE_PLAN_VALIDATION_INVALID');assert.deepEqual(files.at(-1).output,{kind:'image-plan',unexpected:true});
});
test('successful source refusal reuses the exact observation locally without executable instructions',async t=>{
 const f=await fixture(t);f.respond((operation,payload)=>operation==='image-plan'?chat({kind:'image-plan',prompt:'',textMode:'none',expectedText:[],ipRisk:{verdict:'PASS',findings:[]},productUnderstanding:{...understanding(payload),sufficient:false,uncertainties:['Source product not visible.']}}):undefined);
 let sent=0;const first=await f.ai.imagePlan(f.context,()=>{},undefined,undefined,undefined,()=>sent++),before=f.requests.length,again=await f.ai.imagePlan(f.context,()=>{},undefined,undefined,undefined,()=>sent++);assert.equal(again.id,first.id);assert.equal(f.requests.length,before);assert.equal(sent,1);
});

test('repair response recovery requires the exact saved repair request and adds no paid call',async t=>{
 const f=await fixture(t),prior=await f.ai.imagePlan(f.context,()=>{}),repair={previousPlanId:prior.id,issues:['Keep the selected shape.']};
 const original=await f.ai.imagePlan(f.context,()=>{},repair),raw:any=structuredClone(original.output),call={...f.ai.getCall(original.callId)!,status:'FAILED' as const,errorCode:'OUTPUT_INVALID' as const,responseReceived:true as const};
 const db=openDatabase(f.directory);try{db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(call),call.id);db.prepare('DELETE FROM ai_results WHERE id=?').run(original.id);}finally{db.close();}
 const {recordInvalidAiOutput}=await import('../src/main/ai/output-diagnostics.ts');recordInvalidAiOutput(f.directory,{call,operation:'image-plan',createdAt:call.finishedAt!,rejectionStage:'operation-output-validation',output:raw});
 let sent=0;const before=f.requests.length,recovered=await f.ai.imagePlan(f.context,()=>{},repair,undefined,undefined,()=>sent++);
 assert.equal(f.requests.length,before);assert.equal(sent,0);assert.equal(recovered.callId,call.id);assert.deepEqual(recovered.sourceResultIds,original.sourceResultIds);
 await f.ai.imagePlan(f.context,()=>{},{...repair,issues:['Use another scene.']},undefined,undefined,()=>sent++);assert.equal(sent,1);assert.equal(f.requests.length,before+1);
});
test('workflow history and backup accept strictly owned recovered set plans without rewriting paid history',async t=>{
 const f=await fixture(t),{workflow}=productionWorkflow(f,0);(workflow as any).listing.complete=async()=>({draft:f.amazon.getDraft(f.draft.id),aiCalls:0,previewAttempts:0,remaining:[]});
 const completed=await workflow.complete({draftId:f.draft.id,draftRevision:f.draft.revision}),run=completed.workflow;assert.ok(run.setPlanResultId);
 const original=f.ai.getResult(run.setPlanResultId!)!,raw=structuredClone(original.output),call={...f.ai.getCall(original.callId)!,status:'FAILED' as const,errorCode:'OUTPUT_INVALID' as const,responseReceived:true as const};
 const recovered=validateAiResult({...original,imagePlanRecovery:{parserVersion:'image-plan-recovery/v1',contextSha256:original.sourceSha256,rawSha256:listingFingerprint(raw),rawOutput:raw,recoveredAt:original.createdAt}});
 const db=openDatabase(f.directory);try{db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(call),call.id);db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify(recovered),recovered.id);
 const results=new Map(f.ai.listResults(f.product.id).map(result=>[result.id,result])),calls=new Map(f.ai.listCalls().map(call=>[call.id,call]));assert.doesNotThrow(()=>assertImageWorkflowHistory(db,results,calls));
 }finally{db.close();}
 const backup=join(f.directory,'recovered-image.htcbackup');await createWorkspaceBackup(f.directory,backup,'synthetic recovered image history passphrase');await prepareWorkspaceRestore(f.directory,backup,'synthetic recovered image history passphrase');assert.deepEqual(f.ai.getCall(call.id),call);
});
test('W2 finite-schema approved seven images survive proven cost-only adaptation without skipping current identity checks',async t=>{
 const {saveImageAdaptation,inspectImageAdaptation,currentImageAdaptation}=await import('../src/main/image-workflow/adaptation.ts');
 const f=await legacyFixture(t),{workflow,posts}=productionWorkflow(f);
 (workflow as any).listing.complete=async()=>({draft:f.amazon.getDraft(f.draft.id),aiCalls:0,previewAttempts:0,remaining:[]});
 const first=await workflow.complete({draftId:f.draft.id,draftRevision:f.draft.revision});assert.equal(first.workflow.status,'COMPLETED',first.workflow.error??'');assert.equal(posts(),7);
 const db=openDatabase(f.directory);try{
  const before=f.amazon.getDraft(f.draft.id),oldSource=f.store.getProductSnapshot(f.product.id),frozen=String(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(first.workflow.id)!.record_json);
  const input=saveInput(oldSource);input.variants[0].purchasePrice='2.5';const source=f.store.saveProduct(input);await confirmSourceConsistencyFixture(f.directory,f.store,source.id);
  const current=f.store.getProductSnapshot(source.id),preview=f.amazon.previewTaskAdaptation(before.id,current);assert.equal(inspectImageAdaptation(first.workflow,before,preview,current,db).compatible,true);
  const sends=f.requests.length;db.exec('BEGIN IMMEDIATE');const after=f.amazon.applyTaskAdaptation(before.id,current,undefined,db);saveImageAdaptation(db,first.workflow,before,after,current);db.exec('COMMIT');
  assert.equal(currentImageAdaptation(db,first.workflow,after,current),true,'direct returned workflow proof');assert.deepEqual(workflow.getProgress(before.id),first.workflow,'stored parsed workflow');assert.equal(currentImageAdaptation(db,workflow.getProgress(before.id)!,after,current),true,'stored workflow proof');
  assert.equal(approvedWorkflowAssets(db,after,current)?.length,7);assert.equal(String(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(first.workflow.id)!.record_json),frozen);assert.equal(f.requests.length,sends);assert.equal(posts(),7);
  const bad={...after,schema:{...after.schema,version:'different-semantic-version'}};assert.throws(()=>approvedWorkflowAssets(db,bad,current));
 }finally{db.close();}
});

for(const exhausted of [false,true])test('W2 partial cost adaptation preserves paid slots, rollback and restart; exhausted='+exhausted,async t=>{
 const {inspectImageAdaptation,saveImageAdaptation}=await import('../src/main/image-workflow/adaptation.ts');
 const f=await fixture(t),{workflow,posts}=productionWorkflow(f);workflow.saveCopyReviewSettings({enabled:false});
 (workflow as any).listing.complete=async()=>({draft:f.amazon.getDraft(f.draft.id),aiCalls:0,previewAttempts:0,remaining:[]});
 const save=(workflow as any).save.bind(workflow);let paused=false;
 (workflow as any).save=(run:any)=>{save(run);if(!paused&&run.slots?.filter((s:any)=>s.status==='PASSED').length===2){paused=true;workflow.cancel(f.draft.id);}};
 await workflow.complete({draftId:f.draft.id,draftRevision:f.draft.revision});(workflow as any).save=save;
 let prior=workflow.getProgress(f.draft.id)!;assert.equal(prior.slots!.filter(s=>s.status==='PASSED').length,2);assert.equal(posts(),2);
 const db=openDatabase(f.directory);try{
  if(exhausted){const failed=structuredClone(prior),slot=failed.slots![2];slot.status='FAILED';slot.error='Historical planning request budget exhausted';slot.contextSha256=listingFingerprint(validateProductImageContext({...failed.imageContext!,setPlan:failed.setPlan,purpose:slot.purpose,slot:{index:3,total:7,provisional:true}}));slot.attempts=Array.from({length:3},(_,i)=>({number:i+1,requestId:randomUUID(),state:'RETRYABLE_FAILURE' as const,planResultId:null,candidateId:null,ipReviewResultId:null,ocrResultId:null,reviewResultId:null,error:'Historical definite failure'}));failed.attempt=5;db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(JSON.stringify(failed),failed.id);prior=workflow.getProgress(f.draft.id)!;}
  const before=f.amazon.getDraft(f.draft.id),input=saveInput(f.store.getProductSnapshot(f.product.id));input.variants[0].purchasePrice='2.5';f.store.saveProduct(input);await confirmSourceConsistencyFixture(f.directory,f.store,f.product.id);
  const source=f.store.getProductSnapshot(f.product.id),preview=f.amazon.previewTaskAdaptation(before.id,source),check=inspectImageAdaptation(prior,before,preview,source,db);assert.equal(check.compatible,true,check.message);
  const unknown=structuredClone(prior),waiting=unknown.slots![6];waiting.status='UNKNOWN';waiting.attempts=[{number:1,requestId:randomUUID(),state:'UNKNOWN',planResultId:null,candidateId:null,ipReviewResultId:null,ocrResultId:null,reviewResultId:null,error:'Original request unresolved'}];const unknownBytes=JSON.stringify(unknown);assert.equal(inspectImageAdaptation(unknown,before,preview,source,db).compatible,false);assert.equal(JSON.stringify(unknown),unknownBytes,'unknown original request identity and budget untouched');
  const frozen=String(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(prior.id)!.record_json),blueprints=f.requests.filter(r=>r.operation==='image-plan'&&r.payload.setPolicy&&!r.payload.slot).length;
  db.exec('BEGIN IMMEDIATE');const after=f.amazon.applyTaskAdaptation(before.id,source,undefined,db);saveImageAdaptation(db,prior,before,after,source);db.exec('COMMIT');
  const intactBeforeToggle=String(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(prior.id)!.record_json),runCount=Number(db.prepare('SELECT count(*) n FROM image_workflow_runs').get()!.n);
  workflow.saveRiskSettings({enabled:false});await assert.rejects(async()=>workflow.complete({draftId:after.id,draftRevision:after.revision}),/风险开关/);assert.equal(workflow.getProgress(after.id)!.id,prior.id);assert.equal(Number(db.prepare('SELECT count(*) n FROM image_workflow_runs').get()!.n),runCount);assert.equal(String(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(prior.id)!.record_json),intactBeforeToggle);workflow.saveRiskSettings({enabled:true});
  const checkpointSave=(workflow as any).save.bind(workflow);
  (workflow as any).save=(run:any)=>{checkpointSave(run);if(run.sourceReuse)throw Error('derivation checkpoint failure');};
  assert.throws(()=>workflow.complete({draftId:after.id,draftRevision:after.revision}),/derivation checkpoint failure/);assert.equal(workflow.getProgress(after.id)!.id,prior.id);assert.equal(posts(),2);
  let interrupted=false;(workflow as any).save=(run:any)=>{checkpointSave(run);if(run.sourceReuse&&!interrupted&&run.slots.filter((slot:any)=>slot.status==='PASSED').length===3){interrupted=true;workflow.cancel(after.id);}};
  const interruptedRun=await workflow.complete({draftId:after.id,draftRevision:after.revision});assert.equal(posts(),3);assert.equal(interruptedRun.workflow.slots!.filter(slot=>slot.status==='PASSED').length,3);
  workflow.saveRiskSettings({enabled:false});const generation=(workflow as any).generation,listing=(workflow as any).listing;await workflow.close();
  const reopened=new ImageWorkflowService(f.directory,f.store,f.amazon,f.ai,generation,{listing});f.cleanup(()=>reopened.close());
  const stableDerivative=String(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(interruptedRun.workflow.id)!.record_json);await assert.rejects(async()=>reopened.complete({draftId:after.id,draftRevision:after.revision}),/风险开关/);assert.equal(reopened.getProgress(after.id)!.id,interruptedRun.workflow.id);assert.equal(String(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(interruptedRun.workflow.id)!.record_json),stableDerivative);reopened.saveRiskSettings({enabled:true});
  const resumed=await reopened.complete({draftId:after.id,draftRevision:after.revision});assert.equal(resumed.workflow.id,interruptedRun.workflow.id);assert.equal(resumed.workflow.status,exhausted?'BLOCKED':'COMPLETED',resumed.workflow.error??'');assert.equal(posts(),exhausted?6:7);
  assert.deepEqual(resumed.workflow.slots!.slice(0,2),prior.slots!.slice(0,2));assert.equal(resumed.workflow.attempt,exhausted?9:7);assert.equal(resumed.workflow.maxAttempts,prior.maxAttempts);assert.notEqual(resumed.workflow.id,prior.id);
  assert.equal(f.requests.filter(r=>r.operation==='image-plan'&&r.payload.setPolicy&&!r.payload.slot).length,blueprints);assert.equal(String(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(prior.id)!.record_json),frozen);
  for(const slot of resumed.workflow.slots!.slice(2)){if(exhausted&&slot.index===3){assert.deepEqual(slot.attempts,prior.slots![2].attempts);continue;}const plan=f.ai.getResult(slot.attempts[0].planResultId!)!;assert.equal(plan.productRevision,source.revision);const local=await generation.readCandidate(slot.attempts.at(-1)!.candidateId!);assert.equal(local.candidate.productRevision,source.revision);}
  if(exhausted)assert.throws(()=>approvedWorkflowAssets(db,resumed.draft,f.store.getProductSnapshot(source.id)));else assert.equal(approvedWorkflowAssets(db,resumed.draft,f.store.getProductSnapshot(source.id))?.length,7);
  assertImageWorkflowHistory(db,new Map(f.ai.listResults(source.id).map(r=>[r.id,r])),new Map(f.ai.listCalls().map(c=>[c.id,c])));
  const stored=String(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(resumed.workflow.id)!.record_json),forged=JSON.parse(stored);forged.sourceReuse.slotAttempts[0]=0;db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(JSON.stringify(forged),resumed.workflow.id);assert.throws(()=>workflowRuns(db,after.id));db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(stored,resumed.workflow.id);
 }finally{db.close();}
});


test('W2 risk threshold adaptation rechecks the exact blocked candidate without regenerating it',async t=>{
 const {AutomaticListingService}=await import('../src/main/automatic-listing/service.ts'),{defaultListingRules}=await import('../src/shared/listing-rules.ts'),{outcomeScope}=await import('../src/main/automatic-listing/outcomes.ts');
 const f=await fixture(t),{workflow,posts}=productionWorkflow(f);workflow.saveRiskSettings({enabled:true,scoreThreshold:90,levelThreshold:'medium'});
 (workflow as any).listing.complete=async()=>({draft:f.amazon.getDraft(f.draft.id),aiCalls:0,previewAttempts:0,remaining:[]});
 f.respond((operation,payload)=>operation==='ip-upload'?new Response(null,{status:200}):operation==='ImageModeration'?new Response(JSON.stringify({Code:200,RequestId:'moderation-fixture',Data:{DataId:payload.dataId,RiskLevel:'medium',Result:[{Label:'cartoon_ip',Description:'Fixture IP score',Confidence:50}]}})):undefined);
 const profile={id:'alpha',name:'Alpha',enabled:true,configured:true,generation:1};
 const automatic=new AutomaticListingService(f.directory,{store:f.store,amazon:f.amazon,images:workflow,rules:()=>defaultListingRules(),hosting:{getProfile:()=>profile},execution:{list:()=>[],create:()=>{throw Error('Fixture stopped before platform execution');}},followup:{},procurement:{candidates:()=>[]},labels:{list:()=>[]}} as any);f.cleanup(()=>automatic.close());
 const task=await automatic.create({productIds:[f.product.id],targetId:f.draft.targetId,profileId:'alpha',productType:f.draft.schema.productType});
 const blocked=await workflow.complete({draftId:f.draft.id,draftRevision:f.draft.revision});assert.equal(blocked.workflow.status,'BLOCKED',blocked.workflow.error??'');assert.equal(posts(),1);
 const evidence=await workflow.getRuleFilterEvidence(f.draft.id);assert.ok(evidence,'original typed blocked proof');
 const saved=(automatic as any).tasks.get(task.id),row=saved.items[0];Object.assign(row,{draftId:f.draft.id,sourcesPrepared:true,imageStarted:true,imageAttempts:blocked.workflow.attempt,stage:'IMAGES',status:'SCREENED'});row.outcome={version:1,kind:'RULE_FILTERED',code:'IP_IMAGE_BLOCKED',message:evidence.message,classifiedAt:new Date().toISOString(),scope:outcomeScope(saved,row),draftId:f.draft.id,draftRevision:f.draft.revision,image:evidence};(automatic as any).save(saved);
 workflow.saveRiskSettings({enabled:true,scoreThreshold:90,levelThreshold:'high'});
 const preview=automatic.previewAdaptation(task.id);assert.ok(preview.changes.some(c=>c.kind==='RISK_RECHECK'),JSON.stringify(preview.changes));const beforeCalls=f.requests.length;
 const riskDb=openDatabase(f.directory);try{const raw=String(riskDb.prepare('SELECT record_json FROM ai_results WHERE id=?').get(evidence.resultId)!.record_json);
  for(const mutation of ['missing-score','wrong-candidate','wrong-context']){const bad=JSON.parse(raw);if(mutation==='missing-score')bad.output.labels[0].confidence=null;if(mutation==='wrong-candidate')bad.output.candidate.id=randomUUID();if(mutation==='wrong-context')bad.sourceSha256='f'.repeat(64);riskDb.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify(bad),evidence.resultId);assert.equal(automatic.previewAdaptation(task.id).changes.some(c=>c.kind==='RISK_RECHECK'),false,mutation);riskDb.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(raw,evidence.resultId);}
 }finally{riskDb.close();}
 const applied=automatic.applyAdaptation({taskId:task.id,token:preview.token});assert.equal(applied.status,'PAUSED');assert.equal(applied.items[0].status,'PENDING');assert.equal(posts(),1);assert.equal(f.requests.length,beforeCalls);
 const candidate=blocked.workflow.slots![0].attempts[0].candidateId,oldIp=f.ai.getResult(evidence.resultId)!;
 automatic.startAuthorized(automatic.prepareStart(task.id));await automatic.waitForIdle();const completed=workflow.getProgress(f.draft.id)!;assert.equal(completed.status,'COMPLETED',automatic.get(task.id).items[0].error??completed.error??'');assert.equal(posts(),7);assert.equal(completed.slots![0].attempts[0].candidateId,candidate);assert.deepEqual(f.ai.getResult(evidence.resultId),oldIp);assert.equal(row.outcome.kind,'RULE_FILTERED','original exclusion object retained for audit');
});

test('R2 raw control characters recover locally with immutable v2 evidence and no new paid request',async t=>{
 const f=await fixture(t),original=await f.ai.imagePlan(f.context,()=>{}),raw=JSON.stringify(original.output).replace('A blue round coaster','A blue\nround\tcoaster');
 const expected=structuredClone(original.output) as any;expected.productUnderstanding.summary=expected.productUnderstanding.summary.replace('A blue round coaster','A blue\nround\tcoaster');
 const call={...f.ai.getCall(original.callId)!,status:'FAILED' as const,errorCode:'OUTPUT_INVALID' as const,responseReceived:true as const};
 const db=openDatabase(f.directory);try{db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(call),call.id);db.prepare('DELETE FROM ai_results WHERE id=?').run(original.id);}finally{db.close();}
 const {recordInvalidAiOutput}=await import('../src/main/ai/output-diagnostics.ts');recordInvalidAiOutput(f.directory,{call,operation:'image-plan',createdAt:call.finishedAt!,rejectionStage:'provider-response-validation',rejectionReason:'RESPONSE_JSON_INVALID',output:raw});
 const before=f.requests.length,usage=f.ai.getUsageSummary('deepseek'),recovered=await f.ai.recoverImagePlan(call.id,f.context,()=>{});
 assert.ok(recovered);assert.equal(recovered.imagePlanRecovery?.parserVersion,'image-plan-recovery/v2');assert.equal(recovered.imagePlanRecovery?.rawOutput,raw);assert.deepEqual(recovered.output,expected);assert.equal(f.requests.length,before);assert.deepEqual(f.ai.getCall(call.id),call);assert.deepEqual(f.ai.getUsageSummary('deepseek'),usage);assert.equal((await f.ai.recoverImagePlan(call.id,f.context,()=>{}))?.id,recovered.id);
 const aborted=new AbortController();aborted.abort();await assert.rejects(f.ai.recoverImagePlan(call.id,f.context,()=>{},aborted.signal),(e:any)=>e.code==='CANCELLED');
});

test('R2 workflow planning invalid outputs spend at most three attempts across continuation and changed repair feedback',async t=>{
 const f=await fixture(t),workflowId=randomUUID();f.respond(operation=>operation==='image-plan'?chat({kind:'image-plan',unexpected:true}):undefined);
 const before=f.requests.length;await assert.rejects(f.ai.imagePlan(f.context,()=>{},undefined,undefined,workflowId),(e:any)=>e.code==='OUTPUT_INVALID');assert.equal(f.requests.length-before,3);
 await assert.rejects(f.ai.imagePlan(f.context,()=>{},undefined,undefined,workflowId));assert.equal(f.requests.length-before,3);
});

test('R2 metadata-only response diagnostics do not mark responseReceived or invent known fees',async t=>{
 const f=await fixture(t);f.respond(operation=>operation==='image-plan'?new Response(null):undefined);
 await assert.rejects(f.ai.imagePlan(f.context,()=>{}));const call=f.ai.listCalls().find(c=>c.errorCode==='OUTPUT_INVALID')!;
 const {readdirSync}=await import('node:fs'),{hasInvalidAiResponse,hasRetainedInvalidAiOutput,readInvalidAiOutputs}=await import('../src/main/ai/output-diagnostics.ts');
 const saved=readdirSync(join(f.directory,'ai-diagnostics')).map(name=>JSON.parse(readFileSync(join(f.directory,'ai-diagnostics',name),'utf8'))).find(d=>d.callId===call.id);
 assert.ok(saved);assert.equal(saved.rejectionReason,'RESPONSE_BODY_MISSING');assert.equal(saved.output,null);assert.deepEqual(saved.responseDiagnostic,{status:200,byteCount:0});assert.equal(call.responseReceived,undefined);assert.equal(hasInvalidAiResponse(f.directory,call,'image-plan'),false);assert.equal(hasRetainedInvalidAiOutput(f.directory,call,'image-plan'),false);assert.deepEqual(readInvalidAiOutputs(f.directory,call,'image-plan'),[]);assert.equal(f.ai.getUsageSummary('deepseek').unknownCalls,1);
});

test('R2 exact successful workflow planning is reused before another paid request',async t=>{
 const f=await fixture(t),workflowId=randomUUID(),one=await f.ai.imagePlan(f.context,()=>{},undefined,undefined,workflowId),before=f.requests.length;
 assert.equal((await f.ai.imagePlan(f.context,()=>{},undefined,undefined,workflowId)).id,one.id);assert.equal(f.requests.length,before);
});

test('R2 six approved slots and original OCR ledger survive missing seventh planning retries and restart',async t=>{
 const f=await fixture(t),{workflow,posts}=productionWorkflow(f);(workflow as any).listing.complete=async()=>({draft:f.amazon.getDraft(f.draft.id),aiCalls:0,previewAttempts:0,remaining:[]});
 let seventh=0;f.respond((operation,payload)=>operation==='ip-upload'?new Response(null,{status:200}):operation==='image-plan'&&payload.slot?.index===7?(seventh++,chat({kind:'image-plan',unexpected:true})):undefined);
 const first=await workflow.complete({draftId:f.draft.id,draftRevision:f.draft.revision});assert.equal(posts(),6);assert.equal(seventh,3);assert.equal(first.workflow.slots!.filter(s=>s.status==='PASSED').length,6);
 const frozen=structuredClone(first.workflow.slots!.slice(0,6)),db=openDatabase(f.directory),before=db.prepare('SELECT id,record_json FROM ai_calls ORDER BY id').all(),ledger=db.prepare('SELECT id,record_json FROM ai_usage_ledger ORDER BY id').all();db.close();
 const restart=new AiService(f.directory,f.store,(f.ai as any).hosting,mockStorage,{fetch:async()=>{throw Error('No paid planning budget remains');}});const old=(workflow as any).ai;(workflow as any).ai=restart;
 try{const second=await workflow.complete({draftId:f.draft.id,draftRevision:f.draft.revision});assert.equal(second.workflow.id,first.workflow.id);assert.deepEqual(second.workflow.slots!.slice(0,6),frozen);assert.equal(posts(),6);assert.equal(seventh,3);const verify=openDatabase(f.directory);try{assert.deepEqual(verify.prepare('SELECT id,record_json FROM ai_calls ORDER BY id').all(),before);assert.deepEqual(verify.prepare('SELECT id,record_json FROM ai_usage_ledger ORDER BY id').all(),ledger);}finally{verify.close();}}finally{(workflow as any).ai=old;await restart.close();}
});

for(const reason of ['refusal','tool_calls','secret'])test('R2 provider '+reason+' never triggers a paid retry',async t=>{
 const f=await fixture(t);f.respond(operation=>operation==='image-plan'?Response.json({usage:{prompt_tokens:1,completion_tokens:1},choices:[{finish_reason:'stop',message:{content:reason==='secret'?'{"note":"image-fixture-deepseek-key"}':'{}',...(reason==='refusal'?{refusal:'No'}:reason==='tool_calls'?{tool_calls:[{}]}:{})}}]}):undefined);
 const before=f.requests.length;await assert.rejects(f.ai.imagePlan(f.context,()=>{},undefined,undefined,randomUUID()));assert.equal(f.requests.length-before,1);
});
for(const mode of ['cancel','source','config','quota'] as const)test('R2 '+mode+' stops missing-step retries',async t=>{
 const f=await fixture(t),controller=new AbortController();let invalidSent=false;
 f.respond(operation=>{if(operation!=='image-plan')return undefined;invalidSent=true;if(mode==='cancel')controller.abort();if(mode==='config')f.ai.setEnabled({id:'deepseek',enabled:false});return chat({kind:'image-plan',unexpected:true});});
 if(mode==='quota')f.ai.setUsagePolicy({providerId:'deepseek',dailyCallLimit:1,dailyTokenLimit:null});
 const before=f.requests.length;await assert.rejects(f.ai.imagePlan(f.context,()=>{if(mode==='source'&&invalidSent)throw new AiError('SOURCE_CHANGED');},undefined,controller.signal,randomUUID()));assert.equal(f.requests.length-before,1);
});

test('R2 ordinary uncertainties retain full text while measurements remain validated',async t=>{
 const f=await fixture(t),context:ProductImageContext={...f.context,setPolicy:'seven-product-v2',referenceMeasurements:[],setPlan:sceneSet(),purpose:'detail',slot:{index:2,total:7,provisional:true}},uncertainty='The surface is partly obscured by lighting, so fine texture remains uncertain. '.repeat(4).trim();
 f.respond((operation,payload)=>operation==='image-plan'?chat({kind:'image-plan',prompt:'Preserve the selected product with no added text.',textMode:'none',expectedText:[],ipRisk:{verdict:'PASS',findings:[]},productUnderstanding:{...understanding(payload),uncertainties:[uncertainty]}}):undefined);
 const result=await f.ai.imagePlan(context,()=>{});assert.equal((result.output as any).productUnderstanding.uncertainties[0],uncertainty);
 f.respond((operation,payload)=>operation==='image-plan'?chat({kind:'image-plan',prompt:'Preserve the selected product with no added text.',textMode:'none',expectedText:[],ipRisk:{verdict:'PASS',findings:[]},productUnderstanding:{...understanding(payload),uncertainties:[uncertainty+' Product size is 7.5 x 7 x 4.2 cm.']}}):undefined);
 const observed=await f.ai.imagePlan(context,()=>{});if(observed.output.kind!=='image-plan')throw Error('Wrong plan');assert.ok(observed.output.productUnderstanding!.uncertainties[0].includes('7.5 x 7 x 4.2 cm'));assert.doesNotMatch(imageGenerationPrompt(observed.output),/7\.5 x 7 x 4\.2 cm/);
});

test('R2 legacy hashless planning calls and changed repair feedback share the durable slot budget',async t=>{
 const f=await fixture(t),workflowId=randomUUID(),prior=await f.ai.imagePlan(f.context,()=>{},undefined,undefined,workflowId);f.respond(operation=>operation==='image-plan'?chat({kind:'image-plan',unexpected:true}):undefined);
 const before=f.requests.length;await assert.rejects(f.ai.imagePlan(f.context,()=>{},{previousPlanId:prior.id,issues:['Repair original composition.']},undefined,workflowId));assert.equal(f.requests.length-before,2);assert.equal(f.requests.at(-1)!.payload.validationFeedback.includes('selected SKU'),true);
 const db=openDatabase(f.directory);try{for(const row of db.prepare('SELECT id,record_json FROM ai_calls').all()){const call=JSON.parse(String(row.record_json));if(call.presentationContext?.workflowId===workflowId){delete call.presentationContext.imagePlanRequestSha256;db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(call),row.id);}}}finally{db.close();}
 await assert.rejects(f.ai.imagePlan(f.context,()=>{},{previousPlanId:prior.id,issues:['Newly worded repair feedback.']},undefined,workflowId));assert.equal(f.requests.length-before,2);
});

test('R2 concurrent repair requests cannot exceed the shared workflow slot budget',async t=>{
 const f=await fixture(t),workflowId=randomUUID(),prior=await f.ai.imagePlan(f.context,()=>{},undefined,undefined,workflowId),before=f.requests.length;
 f.respond(operation=>operation==='image-plan'?chat({kind:'image-plan',unexpected:true}):undefined);
 const settled=await Promise.allSettled(['First feedback','Second feedback'].map(issue=>f.ai.imagePlan(f.context,()=>{},{previousPlanId:prior.id,issues:[issue]},undefined,workflowId)));
 assert.ok(settled.every(result=>result.status==='rejected'));assert.equal(f.requests.length-before,2);assert.equal(f.ai.listCalls().filter(c=>c.presentationContext?.workflowId===workflowId).length,3);
});

for(const usage of [undefined,null,{prompt_tokens:'bad',completion_tokens:1}])for(const refusal of [true,false])test('R2 malformed usage cannot hide '+(refusal?'refusal':'tool call')+' '+JSON.stringify(usage),async t=>{
 const f=await fixture(t),workflowId=randomUUID();f.respond(operation=>operation==='image-plan'?Response.json({...(usage===undefined?{}:{usage}),choices:[{finish_reason:refusal?'stop':'tool_calls',message:{content:'{}',...(refusal?{refusal:'Cannot comply'}:{tool_calls:[{id:'safe-fixture'}]})}}]}):undefined);
 const before=f.requests.length;await assert.rejects(f.ai.imagePlan(f.context,()=>{},undefined,undefined,workflowId),(e:any)=>e.diagnosticReason==='RESPONSE_NOT_CONTENT');assert.equal(f.requests.length-before,1);
 await assert.rejects(f.ai.imagePlan(f.context,()=>{},undefined,undefined,workflowId));assert.equal(f.requests.length-before,1);assert.equal(f.ai.getUsageSummary('deepseek').unknownCalls,1);
});

test('R2 restoring a backup before image planning preserves all three newer planning calls',async t=>{
 const f=await fixture(t),workflowId=randomUUID(),file=join(f.directory,'before-image-planning.htcbackup'),passphrase='synthetic image planning restore';await createWorkspaceBackup(f.directory,file,passphrase);
 f.respond(operation=>operation==='image-plan'?chat({kind:'image-plan',unexpected:true}):undefined);await assert.rejects(f.ai.imagePlan(f.context,()=>{},undefined,undefined,workflowId));
 const calls=f.ai.listCalls().filter(c=>c.presentationContext?.workflowId===workflowId);assert.equal(calls.length,3);
 const prepared=await prepareWorkspaceRestore(f.directory,file,passphrase),db=openDatabase(prepared.stagingDirectory);
 try{const saved=db.prepare("SELECT record_json FROM ai_calls WHERE json_extract(record_json,'$.presentationContext.workflowId')=?").all(workflowId).map(row=>JSON.parse(String(row.record_json)));assert.equal(saved.length,3);assert.deepEqual(saved.sort((a,b)=>a.id.localeCompare(b.id)),calls.sort((a,b)=>a.id.localeCompare(b.id)));}finally{db.close();}
 const store=new WorkspaceStore(prepared.stagingDirectory),hosting=new HostingService(prepared.stagingDirectory,store,mockStorage);let requests=0;const ai=new AiService(prepared.stagingDirectory,store,hosting,mockStorage,{fetch:async()=>{requests++;throw Error('No remaining planning budget');}});
 try{ai.saveConnection({id:'deepseek',apiKey:'fixture-only'});ai.saveFunctionSettings({id:'deepseek',model:'deepseek-flash',enabled:true});await assert.rejects(ai.imagePlan(f.context,()=>{},undefined,undefined,workflowId),(e:any)=>e.code==='OUTPUT_INVALID');assert.equal(requests,0);}finally{await ai.close();await hosting.close();store.close();}
});

test('R2 standard tool_calls finish reason is nonretryable with valid usage across restart',async t=>{
 const f=await fixture(t),workflowId=randomUUID();f.respond(operation=>operation==='image-plan'?Response.json({usage:{prompt_tokens:2,completion_tokens:3},choices:[{finish_reason:'tool_calls',message:{content:'{}',tool_calls:[{id:'safe-fixture'}]}}]}):undefined);
 const before=f.requests.length;await assert.rejects(f.ai.imagePlan(f.context,()=>{},undefined,undefined,workflowId),(e:any)=>e.diagnosticReason==='RESPONSE_NOT_CONTENT');assert.equal(f.requests.length-before,1);assert.equal(f.ai.getUsageSummary('deepseek').reportedTokens,5);
 let requests=0;const restarted=new AiService(f.directory,f.store,(f.ai as any).hosting,mockStorage,{fetch:async()=>{requests++;throw Error('Refusal must not resend');}});
 try{await assert.rejects(restarted.imagePlan(f.context,()=>{},undefined,undefined,workflowId));assert.equal(requests,0);}finally{await restarted.close();}
});

test('R2 old backup keeps newer successful planning only as spent budget, without importing the result',async t=>{
 const f=await fixture(t),workflowId=randomUUID(),file=join(f.directory,'before-planning-success.htcbackup'),passphrase='synthetic planning success restore';await createWorkspaceBackup(f.directory,file,passphrase);
 const result=await f.ai.imagePlan(f.context,()=>{},undefined,undefined,workflowId),call=f.ai.getCall(result.callId)!;
 const prepared=await prepareWorkspaceRestore(f.directory,file,passphrase),db=openDatabase(prepared.stagingDirectory);
 try{const retained=JSON.parse(String(db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(call.id)!.record_json));assert.deepEqual(retained,{...call,status:'FAILED',errorCode:'INTERRUPTED'});assert.equal(db.prepare('SELECT id FROM ai_results WHERE id=?').get(result.id),undefined);assert.equal(db.prepare("SELECT count(*) n FROM ai_results WHERE json_extract(record_json,'$.callId')=?").get(call.id)!.n,0);assert.deepEqual(JSON.parse(String(db.prepare('SELECT record_json FROM ai_usage_ledger WHERE id=?').get(call.id)!.record_json)).usage,call.usage);}finally{db.close();}
});

test('R2 restore commit retains planning calls sent after preparation and still forbids a fourth send',async t=>{
 const f=await fixture(t),workflowId=randomUUID(),file=join(f.directory,'before-prepared-planning.htcbackup'),passphrase='synthetic commit planning restore';await createWorkspaceBackup(f.directory,file,passphrase);const prepared=await prepareWorkspaceRestore(f.directory,file,passphrase);
 f.respond(operation=>operation==='image-plan'?chat({kind:'image-plan',unexpected:true}):undefined);await assert.rejects(f.ai.imagePlan(f.context,()=>{},undefined,undefined,workflowId));const calls=f.ai.listCalls().filter(c=>c.presentationContext?.workflowId===workflowId);
 await f.ai.close();await (f.ai as any).hosting.close();f.amazon.close();f.store.close();f.store.close=()=>{};
 await commitWorkspaceRestore(f.directory,prepared);
 const store=new WorkspaceStore(f.directory),hosting=new HostingService(f.directory,store,mockStorage);let requests=0;const ai=new AiService(f.directory,store,hosting,mockStorage,{fetch:async()=>{requests++;throw Error('No remaining planning budget');}});
 try{assert.deepEqual(ai.listCalls().filter(c=>c.presentationContext?.workflowId===workflowId).sort((a,b)=>a.id.localeCompare(b.id)),calls.sort((a,b)=>a.id.localeCompare(b.id)));ai.saveConnection({id:'deepseek',apiKey:'fixture-only'});ai.saveFunctionSettings({id:'deepseek',model:'deepseek-flash',enabled:true});await assert.rejects(ai.imagePlan(f.context,()=>{},undefined,undefined,workflowId),(e:any)=>e.code==='OUTPUT_INVALID');assert.equal(requests,0);}finally{await ai.close();await hosting.close();store.close();}
});

test('R2 conflicting planning call identity rejects an old backup without changing current history',async t=>{
 const f=await fixture(t),workflowId=randomUUID(),result=await f.ai.imagePlan(f.context,()=>{},undefined,undefined,workflowId),file=join(f.directory,'planning-identity.htcbackup'),passphrase='synthetic conflicting planning identity';await createWorkspaceBackup(f.directory,file,passphrase);
 const call=f.ai.getCall(result.callId)!,changed={...call,presentationContext:{...call.presentationContext!,workflowId:randomUUID()}},db=openDatabase(f.directory);try{db.prepare('UPDATE ai_calls SET record_json=? WHERE id=?').run(JSON.stringify(changed),call.id);}finally{db.close();}
 await assert.rejects(prepareWorkspaceRestore(f.directory,file,passphrase));assert.deepEqual(f.ai.getCall(call.id),changed);
});

test('R2 malformed usage cannot turn a confirmed credential echo into a formatting retry',async t=>{
 const f=await fixture(t);f.respond(operation=>operation==='image-plan'?Response.json({usage:null,choices:[{finish_reason:'stop',message:{content:'{"note":"image-fixture-deepseek-key"}'}}]}):undefined);
 const before=f.requests.length;await assert.rejects(f.ai.imagePlan(f.context,()=>{},undefined,undefined,randomUUID()),(e:any)=>e.diagnosticReason==='RESPONSE_SECRET_ECHO');assert.equal(f.requests.length-before,1);assert.equal(f.ai.getUsageSummary('deepseek').unknownCalls,1);
});

for(const outcome of ['invalid','refusal','echo'] as const)test(`OpenRouter planning ${outcome} keeps its original bounded retry policy`,async t=>{
 const f=await fixture(t),workflowId=randomUUID();
 f.ai.saveConnection({id:'openrouter',apiKey:'openrouter-image-plan-fixture'});f.ai.setEnabled({id:'openrouter',enabled:true});
 const p=f.ai.getPurposeProfiles().find(p=>p.purposeId==='image_plan')!;f.ai.savePurposeProfile({purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-luna',effort:'medium'}});
 f.respond(operation=>operation!=='image-plan'?undefined:outcome==='invalid'?chat({kind:'image-plan',unexpected:true}):outcome==='echo'?new Response('openrouter-image-plan-fixture'):Response.json({choices:[{finish_reason:'stop',message:{refusal:'No',content:'{}'}}]}));
 const reason=outcome==='invalid'?'IMAGE_PLAN_ATTEMPTS_EXHAUSTED':outcome==='echo'?'RESPONSE_SECRET_ECHO':'RESPONSE_NOT_CONTENT';
 await assert.rejects(f.ai.imagePlan(f.context,()=>{},undefined,undefined,workflowId),(e:any)=>e.diagnosticReason===reason);
 const count=f.requests.length;assert.equal(f.ai.listCalls().filter(c=>c.presentationContext?.workflowId===workflowId).length,outcome==='invalid'?3:1);
 await assert.rejects(f.ai.imagePlan(f.context,()=>{},undefined,undefined,workflowId));assert.equal(f.requests.length,count);
});
for(const gateway of ['deepseek','openrouter'] as const)test(`R2 ${gateway} exhausted planning budget has a specific visible message without a fourth fee`,async t=>{
 const f=await fixture(t),workflowId=randomUUID();f.respond(operation=>operation==='image-plan'?chat({kind:'image-plan',unexpected:true}):undefined);
 if(gateway==='openrouter'){
   f.ai.saveConnection({id:'openrouter',apiKey:'openrouter-image-plan-fixture'});f.ai.setEnabled({id:'openrouter',enabled:true});
   const purpose=f.ai.getPurposeProfiles().find(p=>p.purposeId==='image_plan')!;
   f.ai.savePurposeProfile({purposeId:'image_plan',expectedRevision:purpose.revision,patch:{gateway:'openrouter',model:'openai/gpt-6-luna',effort:'medium'}});
 }
 const exhausted=(e:any)=>{assert.equal(e.code,'OUTPUT_INVALID');assert.equal(e.diagnosticReason,'IMAGE_PLAN_ATTEMPTS_EXHAUSTED');assert.match(e.message,/图片规划已达到 3 次尝试/);assert.match(e.message,/已保留原图和请求记录/);return true;};
 await assert.rejects(f.ai.imagePlan(f.context,()=>{},undefined,undefined,workflowId),exhausted);const calls=f.ai.listCalls(),usage=f.ai.getUsageSummary(gateway),before=f.requests.length;
 assert.equal(calls.filter(c=>c.presentationContext?.workflowId===workflowId).length,3);
 await assert.rejects(f.ai.imagePlan(f.context,()=>{},undefined,undefined,workflowId),exhausted);assert.equal(f.requests.length,before);assert.deepEqual(f.ai.listCalls(),calls);assert.deepEqual(f.ai.getUsageSummary(gateway),usage);
});

test('R2 a restored refusal remains nonretryable without diagnostic files and overrides an older running snapshot',async t=>{
 const f=await fixture(t),workflowId=randomUUID(),file=join(f.directory,'before-refusal-response.htcbackup'),passphrase='synthetic refusal safety restore';
 let respond!:(response:Response)=>void;const waiting=new Promise<Response>(resolve=>{respond=resolve;});f.respond(operation=>operation==='image-plan'?waiting:undefined);
 let sent!:()=>void;const didSend=new Promise<void>(resolve=>{sent=resolve;});const pending=f.ai.imagePlan(f.context,()=>{},undefined,undefined,workflowId,sent);const observed=pending.catch(error=>error);await didSend;
 await createWorkspaceBackup(f.directory,file,passphrase);respond(Response.json({usage:null,choices:[{finish_reason:'tool_calls',message:{content:'{}',tool_calls:[{}]}}]}));await observed;
 const call=f.ai.listCalls().find(c=>c.presentationContext?.workflowId===workflowId)!;assert.equal((call as any).imagePlanRetryBlock,'RESPONSE_NOT_CONTENT');
 const prepared=await prepareWorkspaceRestore(f.directory,file,passphrase),store=new WorkspaceStore(prepared.stagingDirectory),hosting=new HostingService(prepared.stagingDirectory,store,mockStorage);let requests=0;
 const ai=new AiService(prepared.stagingDirectory,store,hosting,mockStorage,{fetch:async()=>{requests++;throw Error('Restored refusal must not resend');}});
 try{ai.saveConnection({id:'deepseek',apiKey:'fixture-only'});ai.saveFunctionSettings({id:'deepseek',model:'deepseek-flash',enabled:true});assert.equal((ai.getCall(call.id) as any).imagePlanRetryBlock,'RESPONSE_NOT_CONTENT');await assert.rejects(ai.imagePlan(f.context,()=>{},undefined,undefined,workflowId));assert.equal(requests,0);assert.equal(ai.listResults(f.product.id).some(result=>result.callId===call.id),false);}finally{await ai.close();await hosting.close();store.close();}
});

test('R2 malformed envelope credential echo stays blocked after restore without diagnostics',async t=>{
 const f=await fixture(t),workflowId=randomUUID(),file=join(f.directory,'before-malformed-envelope.htcbackup'),passphrase='synthetic malformed envelope restore';await createWorkspaceBackup(f.directory,file,passphrase);
 const raw='broken envelope image-fixture-deepseek-key';f.respond(operation=>operation==='image-plan'?new Response(raw):undefined);
 const before=f.requests.length;await assert.rejects(f.ai.imagePlan(f.context,()=>{},undefined,undefined,workflowId),(e:any)=>{assert.equal(e.diagnosticReason,'RESPONSE_SECRET_ECHO');assert.deepEqual(e.responseDiagnostic,{status:200,byteCount:Buffer.byteLength(raw)});return true;});assert.equal(f.requests.length-before,1);
 const call=f.ai.listCalls().find(c=>c.presentationContext?.workflowId===workflowId)!;assert.equal(call.imagePlanRetryBlock,'RESPONSE_SECRET_ECHO');assert.equal(f.ai.getUsageSummary('deepseek').unknownCalls,1);
 const prepared=await prepareWorkspaceRestore(f.directory,file,passphrase);assert.equal((await import('node:fs')).existsSync(join(prepared.stagingDirectory,'ai-diagnostics')),false);
 const store=new WorkspaceStore(prepared.stagingDirectory),hosting=new HostingService(prepared.stagingDirectory,store,mockStorage);let requests=0;const ai=new AiService(prepared.stagingDirectory,store,hosting,mockStorage,{fetch:async()=>{requests++;throw Error('Restored secret echo must not resend');}});
 try{ai.saveConnection({id:'deepseek',apiKey:'fixture-only'});ai.saveFunctionSettings({id:'deepseek',model:'deepseek-flash',enabled:true});assert.equal(ai.getCall(call.id)!.imagePlanRetryBlock,'RESPONSE_SECRET_ECHO');await assert.rejects(ai.imagePlan(f.context,()=>{},undefined,undefined,workflowId));assert.equal(requests,0);}finally{await ai.close();await hosting.close();store.close();}
});

for(const paid of [false,true])test(`Schema transient ${paid?'after':'before'} paid image reply retains response and never repeats POST`,async t=>{
  const {SchemaTransientError}=await import('../src/main/amazon/schema-retry.ts');
  const f=await fixture(t),before=f.requests.length,workflowId=randomUUID();let failing=true;
  const fresh=()=>{if(failing&&(!paid||f.requests.length>before)){const error=new SchemaTransientError('BODY_INCOMPLETE');error.selection=f.draft.schema;throw error;}};
  await assert.rejects(f.ai.imagePlan(f.context,fresh,undefined,undefined,workflowId),e=>e instanceof SchemaTransientError);
  assert.equal(f.requests.length,before+(paid?1:0));
  if(paid){const call=f.ai.listCalls().find(c=>c.presentationContext?.workflowId===workflowId)!;assert.equal(call.responseReceived,true);assert.equal(call.schemaResponseRetained,true);assert.equal(call.usage.promptTokens+call.usage.completionTokens,150);}
  failing=false;
  const recovered=await f.ai.imagePlan(f.context,fresh,undefined,undefined,workflowId);
  assert.equal(recovered.output.kind,'image-plan');assert.equal(f.requests.length,before+1);
  if(paid)assert.equal(recovered.imagePlanRecovery?.parserVersion,'image-plan-recovery/v2');
});

for(const missing of [true,false])test(`retained Schema image response ${missing?'with missing diagnostic':'with changed context'} cannot authorize a new POST`,async t=>{
  const {SchemaTransientError}=await import('../src/main/amazon/schema-retry.ts');
  const f=await fixture(t),before=f.requests.length,workflowId=randomUUID();let failing=true;
  const fresh=()=>{if(failing&&f.requests.length>before)throw Object.assign(new SchemaTransientError('BODY_INCOMPLETE'),{selection:f.draft.schema});};
  await assert.rejects(f.ai.imagePlan(f.context,fresh,undefined,undefined,workflowId));failing=false;
  if(missing)rmSync(join(f.directory,'ai-diagnostics'),{recursive:true,force:true});
  const context=structuredClone(f.context);if(!missing)context.listing.schemaVersion+='changed';
  await assert.rejects(f.ai.imagePlan(context,fresh,undefined,undefined,workflowId));assert.equal(f.requests.length,before+1);
});

test('Schema retained paid response marker survives an older backup call record',async t=>{
  const {SchemaTransientError}=await import('../src/main/amazon/schema-retry.ts');
  const {retainSchemaResponseCalls}=await import('../src/main/ai/usage.ts');
  const f=await fixture(t),before=f.requests.length,workflowId=randomUUID();
  await assert.rejects(f.ai.imagePlan(f.context,()=>{if(f.requests.length>before)throw Object.assign(new SchemaTransientError('BODY_INCOMPLETE'),{selection:f.draft.schema});},undefined,undefined,workflowId));
  const current=openDatabase(f.directory),folder=mkdtempSync(resolve('.test-data/schema-paid-backup-')),snapshot=openDatabase(folder);
  try{
    const call=f.ai.listCalls().find(c=>c.presentationContext?.workflowId===workflowId)!;
    const old={...call,status:'RUNNING',errorCode:null,finishedAt:null};delete old.schemaResponseRetained;delete old.responseReceived;
    snapshot.prepare('INSERT INTO ai_calls VALUES(?,?)').run(call.id,JSON.stringify(old));retainSchemaResponseCalls(current,snapshot);
    const retained=JSON.parse(String(snapshot.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(call.id)!.record_json));
    assert.equal(retained.schemaResponseRetained,true);assert.equal(retained.responseReceived,true);assert.deepEqual(retained.usage,call.usage);
  }finally{snapshot.close();current.close();rmSync(folder,{recursive:true,force:true});}
});

function enableAppearance(f:Awaited<ReturnType<typeof fixture>>){
 for(const purposeId of ['appearance_review','appearance_review_difficult'] as const){const previous=f.ai.getPurposeProfiles().find(p=>p.purposeId===purposeId)!;f.ai.savePurposeProfile({purposeId,expectedRevision:previous.revision,patch:{gateway:'deepseek',model:'deepseek-flash',effort:'none'}});}
}
function appearanceReply(payload:any,verdict='PASS'){return chat({verdict,checks:[{aspect:'color',expected:'Blue coaster',observed:verdict==='MISMATCH'?'Red coaster':'Blue coaster',reason:'Product body compared; table props excluded',referenceAssetIds:payload.referenceImages.map((r:any)=>r.assetId)}]});}
test('W07 appearance sends actual source plus candidate and preserves raw receipt with independent purpose',async t=>{
 const f=await fixture(t);enableAppearance(f);f.respond((operation,payload)=>operation==='image-appearance-review'?appearanceReply(payload):undefined);
 const plan=await f.ai.imagePlan(f.context,()=>{}),review=await f.ai.reviewGeneratedImageAppearance(f.context,plan,f.candidate,f.bytes,()=>{});
 assert.equal(review.output.kind,'image-appearance-review');assert.deepEqual(validateAiResult(review),review);
 const request=f.requests.at(-1)!;assert.equal(request.operation,'image-appearance-review');assert.equal(request.body.messages[1].content.length,3);assert.equal(request.body.messages[1].content.at(-1).image_url.url,`data:image/png;base64,${f.bytes.toString('base64')}`);
 const call=f.ai.getCall(review.callId)!;assert.equal(call.purposeSnapshot?.purposeId,'appearance_review');assert.ok(call.providerReceiptId);assert.ok(await f.ai.readProviderReceipt(call.id));
});
for(const mode of ['pass','mismatch-once','uncertain'] as const)test(`W07 seven slots appearance ${mode} is local and bounded`,async t=>{
 const f=await fixture(t),{workflow,posts}=productionWorkflow(f);enableAppearance(f);workflow.saveAppearanceReviewSettings({enabled:true});let reviews=0;
 f.respond((operation,payload)=>operation==='ip-upload'?new Response(null,{status:200}):operation==='image-appearance-review'?appearanceReply(payload,(++reviews,mode==='uncertain'?'UNCERTAIN':mode==='mismatch-once'&&reviews===2?'MISMATCH':'PASS')):undefined);
 const result=await workflow.complete({draftId:f.draft.id,draftRevision:f.draft.revision});
 if(mode==='uncertain'){assert.equal(result.workflow.status,'BLOCKED',result.workflow.error??'');assert.equal(posts(),7);assert.equal(reviews,14);assert.ok(result.workflow.slots!.every(slot=>slot.status==='BLOCKED'&&slot.attempts.length===1&&slot.attempts[0].appearanceReview?.resultIds.length===2));}
 else{assert.equal(result.workflow.status,'COMPLETED',result.workflow.error??'');assert.equal(posts(),mode==='pass'?7:8);assert.equal(reviews,posts());assert.deepEqual(result.workflow.slots!.map(slot=>slot.attempts.length),mode==='pass'?[1,1,1,1,1,1,1]:[1,2,1,1,1,1,1]);}
 if(mode==='pass'){const db=openDatabase(f.directory);try{assertImageWorkflowHistory(db,new Map(f.ai.listResults(f.product.id).map(r=>[r.id,r])),new Map(f.ai.listCalls().map(c=>[c.id,c])));}finally{db.close();}await createWorkspaceBackup(f.directory,join(f.directory,'appearance.htcbackup'),'synthetic appearance history backup');}
 const before=reviews;await workflow.complete({draftId:f.draft.id,draftRevision:f.amazon.getDraft(f.draft.id).revision});assert.equal(reviews,before);
});

test('W07 default OpenRouter Luna to Sol appearance escalation uses real service validation and preserves all seven slots',async t=>{
 const f=await fixture(t),{workflow,posts}=productionWorkflow(f);
 f.ai.saveConnection({id:'openrouter',apiKey:'synthetic-openrouter-review-key'});f.ai.saveFunctionSettings({id:'openrouter-review',model:'openai/gpt-6-luna',enabled:true});
 const configured=f.ai.getPurposeProfiles();assert.equal(configured.find(p=>p.purposeId==='appearance_review')!.model,'openai/gpt-6-luna');assert.equal(configured.find(p=>p.purposeId==='appearance_review_difficult')!.model,'openai/gpt-6.1-sol');
 workflow.saveAppearanceReviewSettings({enabled:true});
 f.respond((operation,payload)=>operation==='ip-upload'?new Response(null,{status:200}):operation==='image-appearance-review'?appearanceReply(payload,payload.previousReview?'PASS':'UNCERTAIN'):undefined);
 const result=await workflow.complete({draftId:f.draft.id,draftRevision:f.draft.revision});assert.equal(result.workflow.status,'COMPLETED',result.workflow.error??'');assert.equal(posts(),7);
 const requests=f.requests.filter(r=>r.operation==='image-appearance-review');assert.equal(requests.length,14);
 for(const [index,request] of requests.entries()){assert.equal(request.body.model,index%2===0?'openai/gpt-6-luna':'openai/gpt-6.1-sol');assert.equal(request.body.messages[1].content.length,3);}
 for(const slot of result.workflow.slots!){assert.equal(slot.attempts.length,1);const ids=slot.attempts[0].appearanceReview!.resultIds;assert.equal(ids.length,2);for(const [index,id] of ids.entries()){const review=f.ai.getResult(id)!;assert.equal(review.providerId,'openrouter-review');assert.deepEqual(validateAiResult(review),review);assert.equal(review.output.kind,'image-appearance-review');if(review.output.kind==='image-appearance-review'){assert.equal(review.output.verdict,index===0?'UNCERTAIN':'PASS');assert.equal(review.output.previousResultId,index===0?null:ids[0]);}assert.ok(f.ai.getCall(review.callId)!.providerReceiptId);}}
 const before=requests.length;await workflow.complete({draftId:f.draft.id,draftRevision:f.amazon.getDraft(f.draft.id).revision});assert.equal(f.requests.filter(r=>r.operation==='image-appearance-review').length,before);
});
test('A19 image workflow resumes a pending current-copy upgrade before considering copy repair',async t=>{
 const f=await fixture(t),before=f.ai.listResults(f.product.id).length;let reviewCalls=0;
 f.respond((operation,payload)=>{if(operation!=='listing-current-review')return undefined;reviewCalls++;const out=currentReview(payload);out.verdict='NEEDS_CHANGES';out.checks[0].verdict='UNSUPPORTED';out.checks[0].reason='Specific source ambiguity';out.checks[0].claims[0].verdict='UNSUPPORTED';out.checks[0].claims[0].reason='Specific source ambiguity';out.issues=[{field:out.checks[0].field,message:'Specific source ambiguity'}] as any;return chat(out);});
 await assert.rejects(f.ai.reviewCurrentListing(f.context.listing,f.context.currentListingCopy,async()=>{if(f.ai.listResults(f.product.id).length>before)throw new Error('exit after first');}),/exit after first/);
 const pending=f.ai.listResults(f.product.id).filter(r=>r.output.kind==='listing-current-review').at(-1)!;assert.equal(f.ai.hasPendingCopyReview(pending.id),true);
 const {workflow,posts}=productionWorkflow(f),listing=(workflow as any).listing;let resumed=0,repairs=0;listing.complete=async()=>({draft:f.amazon.getDraft(f.draft.id),aiCalls:0,previewAttempts:0,remaining:[]});listing.reviewCurrentForImages=async()=>{resumed++;throw new Error('resume original upgrade');};listing.repairCurrentForImages=async()=>{repairs++;throw new Error('must not repair while upgrade pending');};
 const result=await workflow.complete({draftId:f.draft.id,draftRevision:f.draft.revision});assert.equal(resumed,1,result.workflow.error??'expected original review entry');assert.equal(repairs,0);assert.notEqual(result.workflow.status,'COMPLETED');assert.equal(posts(),0);assert.equal(reviewCalls,1);
});
