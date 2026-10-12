import { pricingAttributeInputs } from '../src/main/amazon/pricing-inputs.ts';
import { confirmSourceConsistencyFixture } from './helpers/source-consistency-proof.ts';
import { SourceConsistencyError } from '../src/main/source-image-consistency/proof.ts';
import { sceneSet } from './fixtures/image-set.ts';
import { attachNativeHistory } from './helpers/source-image-receipt.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { AmazonService } from '../src/main/amazon/service.ts';
import { SkuNamingService } from '../src/main/sku-naming/service.ts';
import { buildSalesRecipes } from '../src/main/sales-plans/recipes.ts';
import { salesStoreScope } from '../src/main/sales-plans/planning.ts';
import { defaultListingRules } from '../src/shared/listing-rules.ts';
import type { AmazonDraft, JsonObject } from '../src/shared/amazon-contracts.ts';
import type { SalesListingPlan } from '../src/shared/sales-plan-contracts.ts';
import { importImageFiles } from '../src/main/assets.ts';
// Frozen field-metadata migration fixtures use the historical finite context.
import { LegacyListingAiService as ListingAiService } from './helpers/legacy-listing-context.ts';
import { buildListingContext } from '../src/main/listing-ai/context.ts';
import { ImageWorkflowService } from '../src/main/image-workflow/service.ts';

import { openDatabase } from '../src/main/database.ts';
import { approvedWorkflowAsset, approvedWorkflowAssets, imageWorkflowDraftStamp, validateImageWorkflowRun } from '../src/main/image-workflow/records.ts';
import { AiError } from '../src/main/ai/errors.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import type { AiCall, AiResult } from '../src/shared/ai-contracts.ts';
import type { GeneratedImageCandidate } from '../src/shared/image-generation-contracts.ts';
import { PRODUCT_IMAGE_POLICY_VERSION } from '../src/shared/image-ai-contracts.ts';
import type { ProductImageContext } from '../src/shared/image-ai-contracts.ts';
import type { ListingAiContext, ListingEvidence } from '../src/shared/listing-ai-contracts.ts';
import { listingFingerprint } from '../src/main/listing-ai/validation.ts';
import { OpenAiImageAdapter } from '../src/main/image-generation/adapter.ts';
import { canResumeImageWorkflow } from '../src/shared/image-workflow-contracts.ts';
import { currentImageListingSnapshot } from '../src/main/image-workflow/image-facts.ts';
import { applyBusinessRules } from '../src/main/amazon/business-rules.ts';
import { realAmazonSchema } from './fixtures/amazon/schema-fixture.ts';
import { ListingRuleStore } from '../src/main/listing-rules.ts';
import type { AmazonPersistence } from '../src/main/amazon/persistence.ts';

const png = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(13,8); png.write('IHDR',12); png.writeUInt32BE(256,16); png.writeUInt32BE(256,20);
test('native historical multiplicity blocks orphan refs in runSeven, completed reuse, recheck and rule proof',async t=>{
  const fresh=await fixture(t);attachNativeHistory(fresh.root,fresh.product);
  await assert.rejects(async()=>fresh.run(),error=>error instanceof SourceConsistencyError&&error.code==='SOURCE_CONSISTENCY_IDENTITY_INVALID');assert.equal(fresh.calls.includes('generate'),false);
  const prior=await fixture(t),completed=await prior.run();assert.equal(completed.workflow.status,'COMPLETED');
  attachNativeHistory(prior.root,prior.product);const count=prior.calls.length;
  await assert.rejects(async()=>prior.run());
  await assert.rejects(async()=>prior.service.recheck({draftId:prior.draft.id,draftRevision:prior.amazon.getDraft(prior.draft.id).revision,sourceWorkflowId:completed.workflow.id}));
  assert.equal(await prior.service.getRuleFilterEvidence(prior.draft.id),null);assert.equal(prior.calls.length,count);
});
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function copyReview(context:ListingAiContext,copy:{field:any;values:string[]}[]){
  return {kind:'listing-current-review' as const,verdict:'PASS' as const,currentListingCopy:copy,copySha256:listingFingerprint(copy),issues:[],checks:copy.flatMap(item=>item.values.map((value,index)=>{
    const evidenceIds=context.evidence.filter(e=>['material','color','item_shape','care_instructions'].includes(item.field)?e.meaning===item.field:true).map(e=>e.id);
    return {field:item.field,index,verdict:'SUPPORTED' as const,evidenceIds,reason:'Fixture source.',claims:[{text:value,verdict:'SUPPORTED' as const,evidenceIds,reason:'Fixture source.'}]};
  }))};
}
async function fixture(t: test.TestContext, options: { familyMigration?:boolean; lostResponse?:boolean; rejectSlot?:number; knownGenerationFailures?:number; rejected?: number; configured?: boolean; generationError?: boolean; mutate?: boolean; hold?: boolean; rotateKeyDuringPlan?: boolean; insufficient?: boolean; legacyPlan?: boolean; ipVerdict?: 'PASS'|'BLOCKED'|'UNCERTAIN'; generatedRisk?: boolean; riskFailure?: boolean } = {}) {
  t.mock.method(globalThis,'fetch',()=>{throw new Error('External network is forbidden in image workflow fixtures');});
  await mkdir(resolve('.test-data'), { recursive:true }); const root = await mkdtemp(resolve('.test-data/image-flow-'));
  const store = new WorkspaceStore(root), amazon = new AmazonService(root, id => store.getProduct(id), {isEncryptionAvailable:()=>false, encryptString:()=>Buffer.alloc(0), decryptString:()=>''});
  let product = store.createProduct(); const source = join(root,'source.png'); await writeFile(source,png);
  product = await importImageFiles(store,root,{productId:product.id,revision:product.revision},[source], bytes=>bytes);
  const target = amazon.enableDemo();let draft:AmazonDraft, familyPlan:SalesListingPlan|undefined;
  if(options.familyMigration){
    product=store.saveProduct({id:product.id,revision:product.revision,title:product.title,sourceUrl:product.sourceUrl,description:product.description,status:product.status,facts:product.facts,
      variants:product.variants.map(({id,sku,inventory})=>({id,sku,inventory,originalSpec:'型号: A / 颜色: 松针绿 / 包装: 1个装',normalizedSpec:'',purchasePrice:'20'}))});
    const naming=new SkuNamingService(root);
    try{
      const recipe=buildSalesRecipes(product,null,defaultListingRules())[0],storeScope=salesStoreScope(target);
      const legacy=naming.allocate({storeScope,storeCode:'U2',sourceGroupKey:`local:${product.id}:${'a'.repeat(64)}`,collectedAt:product.createdAt,childKeys:[]});
      const parent=naming.allocate({storeScope,storeCode:'U2',sourceGroupKey:`local:${product.id}:family:${recipe.groupKey}`,collectedAt:product.createdAt,childKeys:[]});
      const plan:SalesListingPlan={namingGroupId:legacy.id,sourceGroupKey:legacy.sourceGroupKey,collectedAt:legacy.collectedAt,collectionBasis:'first_import',sku:legacy.baseSku,baseSku:legacy.baseSku,
        recipe:{...recipe,color:'',groupKey:'a'.repeat(64)},parentage:'NONE',parentSku:null,variationTheme:null,relationReason:'Historical independent SKU',familyResolved:true,namingChildKey:null};
      familyPlan={...structuredClone(plan),parentage:'CHILD',parentSku:parent.baseSku,variationTheme:'COLOR',relationReason:'Confirmed source color family',
        familyBinding:{parentNamingGroupId:parent.id,parentSourceGroupKey:parent.sourceGroupKey,parentBaseSku:parent.baseSku}};
      const market=target.marketplaceId;
      const result=await amazon.prepareDrafts({targetId:target.id,productType:'HTC_DEMO_STORAGE_BAG',parentageLevel:'NONE',requirements:'LISTING',locale:'en_US',items:[{productId:product.id,productRevision:product.revision,variantId:product.variants[0].id,attributes:{
        brand:[{value:'Generic',marketplace_id:market}],color:[{value:'Pine Needle Green',marketplace_id:market}],
        purchasable_offer:[{marketplace_id:market,currency:'USD',audience:'ALL',our_price:[{schedule:[{value_with_tax:10}]}]}]}}]},[plan]);
      assert.ok(result.items[0].draft,result.items[0].error??'historical sales draft');draft=result.items[0].draft;
    }finally{naming.close();}
  }else draft=await amazon.createDraft({targetId:target.id,productId:product.id,variantId:product.variants[0].id,productType:'HTC_DEMO_STORAGE_BAG',parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'});
  const calls: string[] = [], candidates = new Map<string,{candidate:GeneratedImageCandidate;bytes:Buffer;preview:Buffer}>();
  const results = new Map<string,AiResult>();
  const outputResult = (output: unknown, imageContext?:ProductImageContext) => {
    const value = { id:randomUUID(), callId:randomUUID(), output, ...(imageContext?{imageContext,sourceSha256:listingFingerprint(imageContext)}:{}) } as AiResult;
    results.set(value.id,value); return value;
  };
  const generationInputs: {referenceAssetIds:string[];prompt:string}[] = [];
  let imageCount = 0, reviewCount = 0, release!:()=>void, started!:()=>void, configurationScope=randomUUID();
  const held = new Promise<void>(r=>release=r), began = new Promise<void>(r=>started=r);
  const listing = {
    snapshotCurrentForImages:async()=>({context:buildListingContext(amazon.getDraft(draft.id),store.getProduct(product.id),amazon.executionTargetScope(target.id).generation),currentListingCopy:[{field:'item_name' as const,values:[product.title]}]}),
    complete: async()=> { calls.push('content'); return {draft:amazon.getDraft(draft.id),aiCalls:2,previewAttempts:1,remaining:[] as string[]}; },
    reviewCurrentForImages: async()=> { calls.push('content-review');const context=buildListingContext(amazon.getDraft(draft.id),store.getProduct(product.id),amazon.executionTargetScope(target.id).generation),currentListingCopy=[{field:'item_name',values:[product.title]}];return {context,review:outputResult(copyReview(context,currentListingCopy)),currentListingCopy}; },
  };
  const ai = {
    getResult: (id:string)=>results.get(id)!,
    listResults:()=>[...results.values()],
    recognize:async()=>{calls.push('source-ocr');return outputResult({kind:'ocr',text:'',lines:[]});},
    getCall: ()=>({status:'SUCCEEDED'}),
    getProfile: ()=>({enabled:true,configured:true,generation:1}),
    imagePlan: async(imageContext:ProductImageContext)=>{calls.push(imageContext.setPolicy&&!imageContext.slot?'set-plan':'plan');if(options.rotateKeyDuringPlan)configurationScope=randomUUID();return outputResult({...(imageContext.setPolicy&&!imageContext.slot?{setPlan:sceneSet()}:{}),kind:'image-plan',prompt:'Show this product',textMode:'none',expectedText:[],ipRisk:{verdict:options.ipVerdict??'PASS',findings:options.ipVerdict&&options.ipVerdict!=='PASS'?[{category:'character',name:'Mickey Mouse',evidence:'Distinctive named character in source image.',referenceAssetIds:[imageContext.referenceAssets[0].assetId]}]:[]},...(!options.legacyPlan?{productUnderstanding:{summary:'A blue round coaster with a raised rim.',referenceAssetIds:imageContext.referenceAssets.map(asset=>asset.assetId),uncertainties:options.insufficient?['Selected SKU cannot be identified.']:['Exact size is unknown.'],sufficient:!options.insufficient}}:{})});},
    reviewGeneratedImageRisk: async(_context:unknown,plan:AiResult,candidate:unknown)=>{calls.push('ip-check'); if(options.riskFailure)throw new AiError('SERVICE_PERMISSION_REQUIRED'); return outputResult({kind:'image-ip-review',candidate,planResultId:plan.id,service:'aigcViolationDetection',verdict:options.generatedRisk?'BLOCKED':'PASS',riskLevel:options.generatedRisk?'high':'none',labels:[{label:options.generatedRisk?'tm_goods':'nonLabel',confidence:options.generatedRisk?99:null,description:options.generatedRisk?'疑似品牌商标':'未检出风险'}]});},
    recognizeGeneratedImage: async(_context:unknown,candidate:unknown)=>{calls.push('ocr');return outputResult({kind:'generated-image-ocr',candidate,text:'',lines:[]});},
    reviewGeneratedImage: async(_c:unknown,plan:AiResult,ocr:AiResult,candidate:unknown)=>{
      calls.push('review'); reviewCount++; if(options.mutate)store.saveProduct({...store.getProduct(product.id),title:'changed'});
      const rejected=options.rejectSlot===(_c as ProductImageContext).slot?.index||reviewCount <= (options.rejected??0);
      return outputResult({kind:'image-text-review',candidate,planResultId:plan.id,ocrResultId:ocr.id,verdict:rejected?'NEEDS_CHANGES':'PASS',checks:[],expectedTextChecks:[],issues:rejected?['Text 10 pieces at center contradicts source 5 pieces; expected 5 pieces.']:[],visualReview:'not_performed'},_c as ProductImageContext);
    },
  };
  const generation = {
    configurationScope:()=>configurationScope,
    getConnection: ()=>({configured:options.configured??true,enabled:true,provider:'openai',model:'gpt-image-2.5-sunburst',size:'1024x1024',quality:'high'}),
    generate: async(input:{referenceAssetIds:string[];prompt:string},signal?:AbortSignal)=> {
      generationInputs.push(input);
      calls.push('generate'); imageCount++; started(); if(options.hold) await held;
      if(signal?.aborted)throw new AiError('CANCELLED'); if(options.generationError)throw new AiError('TIMEOUT');
      const bytes = Buffer.from(png); bytes[32]=imageCount;
      const candidate = {id:randomUUID(),provider:'openai',model:'gpt-image-2.5-sunburst',mode:'edit',productId:product.id,productRevision:product.revision,sourceAssets:input.referenceAssetIds.map(id=>({id,sha256:store.getAssetRecord(id)!.sha256})),createdAt:new Date().toISOString(),requestId:null,reviewState:'unreviewed',mimeType:'image/png',width:256,height:256,byteSize:bytes.length,sha256:hash(bytes),previewUrl:''} as GeneratedImageCandidate;
      candidates.set(candidate.id,{candidate,bytes,preview:bytes}); return candidate;
    },
    readCandidate: async(id:string)=>candidates.get(id)!,
    generateForWorkflow:async(input:any,attempt:{requestId:string;editCandidateId?:string},signal?:AbortSignal)=>{
      if(options.knownGenerationFailures&&options.knownGenerationFailures-->0){calls.push('generate');throw Object.assign(new AiError('PROVIDER_ERROR'),{definitive:true});}
      const candidate=await generation.generate(input,signal),local=candidates.get(candidate.id)!;candidates.delete(candidate.id);candidate.id=attempt.requestId;candidates.set(candidate.id,local);if(options.lostResponse){options.lostResponse=false;throw new AiError('TIMEOUT');}return candidate;
    },
    reconcileWorkflowGeneration:async(id:string)=>candidates.get(id)?.candidate??null,
  };
  await confirmSourceConsistencyFixture(root,store,product.id);
  const service = new ImageWorkflowService(root,store,amazon,ai as never,generation as never,{listing:listing as never});
  t.after(async()=>{release(); await service.close(); amazon.close(); store.close(); await rm(root,{recursive:true,force:true});});
  return {root,store,amazon,product,draft,familyPlan,service,calls,listing,ai,generation,generationInputs,release,began,reopen:()=>new ImageWorkflowService(root,store,amazon,ai as never,generation as never,{listing:listing as never}),run:()=>service.complete({draftId:draft.id,draftRevision:amazon.getDraft(draft.id).revision})};
}

// Exercise the real listing context builder and image snapshot together with the
// workflow. Only provider responses and the version-specific card projection vary.
test('direct image workflow blocks a stale v2 successful quote before color, field, plan or generation calls',async t=>{
  const f=await fixture(t),p=(f.amazon as unknown as {persistence:AmazonPersistence}).persistence,r=p.record(f.draft.id);
  const priced=applyBusinessRules({product:f.product,variant:f.product.variants[0],schema:realAmazonSchema(),target:f.amazon.getTarget(f.draft.targetId),attributes:{},measurements:{},costCny:2.4,now:new Date()},defaultListingRules());
  r.draft.listingProgram='haul';r.draft.businessRules={...priced.report,fields:{}};r.draft.attributes.item_package_weight=null;p.putRecord(r);
  const result=await f.run();assert.equal(result.workflow.status,'BLOCKED');assert.match(result.workflow.error!,/定价/);assert.deepEqual(f.calls,[]);
});

test('a paid image plan remains stored when pricing changes during its response and the next generation never starts',async t=>{
  const f=await fixture(t),p=(f.amazon as unknown as {persistence:AmazonPersistence}).persistence,r=p.record(f.draft.id),rules=new ListingRuleStore(f.root);
  try{
    const priced=applyBusinessRules({product:f.product,variant:f.product.variants[0],schema:realAmazonSchema(),target:f.amazon.getTarget(f.draft.targetId),attributes:{},measurements:{},costCny:2.4,now:new Date()},rules.get());
    r.draft.listingProgram='haul';r.draft.businessRules={...priced.report,fields:{}};if(r.draft.businessRules.pricingDecision?.version===2)r.draft.businessRules.pricingDecision.attributeInputs=pricingAttributeInputs(r.draft.attributes);p.putRecord(r);
    const plan=f.ai.imagePlan;f.ai.imagePlan=async context=>{const result=await plan(context);if(context.slot)rules.save(rules.get());return result;};
    const result=await f.run();assert.equal(result.workflow.status,'BLOCKED');assert.match(result.workflow.error!,/定价/);
    assert.ok(result.workflow.slots?.[0].attempts[0].planResultId);assert.equal(result.workflow.slots?.[0].attempts[0].state,'READY');assert.ok(!f.calls.includes('generate'));
  }finally{rules.close();}
});


test('stale v2 pricing permits local UNKNOWN reconciliation but never starts the next paid check',async t=>{
  const f=await fixture(t,{lostResponse:true}),p=(f.amazon as unknown as {persistence:AmazonPersistence}).persistence,r=p.record(f.draft.id),rules=new ListingRuleStore(f.root);
  try{
    const priced=applyBusinessRules({product:f.product,variant:f.product.variants[0],schema:realAmazonSchema(),target:f.amazon.getTarget(f.draft.targetId),attributes:{},measurements:{},costCny:2.4,now:new Date()},rules.get());
    r.draft.listingProgram='haul';r.draft.businessRules={...priced.report,fields:{}};if(r.draft.businessRules.pricingDecision?.version===2)r.draft.businessRules.pricingDecision.attributeInputs=pricingAttributeInputs(r.draft.attributes);p.putRecord(r);
    const first=await f.run();assert.equal(first.workflow.slots![0].attempts[0].state,'UNKNOWN');
    const count=f.calls.length;rules.save(rules.get());const result=await f.run();
    assert.equal(result.workflow.id,first.workflow.id);assert.equal(result.workflow.slots![0].attempts[0].state,'GENERATED');
    assert.equal(result.workflow.slots![0].attempts[0].candidateId,first.workflow.slots![0].attempts[0].requestId);
    assert.match(result.workflow.error!,/定价/);assert.equal(f.calls.length,count);
  }finally{rules.close();}
});

function currentListingBridge(f:Awaited<ReturnType<typeof fixture>>) {
  const real=new ListingAiService(f.store,f.amazon,f.ai as never);
  const calls=new Map<string,AiCall>();
  const seal=(result:AiResult,context:ProductImageContext,providerId:AiResult['providerId'])=>{
    Object.assign(result,{providerId,productId:f.product.id,productRevision:f.product.revision,variantId:f.draft.variantId,model:'fixture',createdAt:new Date().toISOString(),imageContext:structuredClone(context),sourceSha256:listingFingerprint(context)});
    calls.set(result.callId,{id:result.callId,providerId,productId:result.productId,productRevision:result.productRevision,model:result.model,status:'SUCCEEDED',finishedAt:result.createdAt} as AiCall);
    return result;
  };
  const plan=f.ai.imagePlan,risk=f.ai.reviewGeneratedImageRisk,ocr=f.ai.recognizeGeneratedImage,text=f.ai.reviewGeneratedImage;
  f.ai.imagePlan=async context=>seal(await plan(context),context,'deepseek');
  f.ai.reviewGeneratedImageRisk=async(context,plan,candidate)=>seal(await risk(context,plan,candidate),context as ProductImageContext,'aliyun-image-risk');
  f.ai.recognizeGeneratedImage=async(context,candidate)=>seal(await ocr(context,candidate),context as ProductImageContext,'aliyun-ocr');
  f.ai.reviewGeneratedImage=async(context,plan,ocr,candidate)=>{
    const result=seal(await text(context,plan,ocr,candidate),context as ProductImageContext,'deepseek-review');
    Object.assign(result.output,{noTextVerified:true});return result;
  };
  (f.ai as any).getCall=(id:string)=>calls.get(id)??{status:'SUCCEEDED'};
  let project=(context:ListingAiContext)=>context;
  const currentContext=(...args:Parameters<ListingAiService['currentContext']>)=>project(real.currentContext(...args));
  Object.assign(f.listing,{currentContext});
  const snapshot=async()=>{const draft=f.amazon.getDraft(f.draft.id);return currentImageListingSnapshot(draft,currentContext(draft,f.store.getProduct(draft.productId),f.amazon.executionTargetScope(draft.targetId).generation));};
  f.listing.snapshotCurrentForImages=snapshot as typeof f.listing.snapshotCurrentForImages;
  const review=f.listing.reviewCurrentForImages;
  f.listing.reviewCurrentForImages=async()=>{
    const original=await review(),value=await snapshot();
    Object.assign(original.review,{listingContext:structuredClone(value.context),sourceSha256:listingFingerprint(value.context)});
    Object.assign(original.review.output,copyReview(value.context,value.currentListingCopy));
    return {...value,review:original.review};
  };
  return {project:(value:typeof project)=>{project=value;}};
}
function olderFieldMetadata(context:ListingAiContext):ListingAiContext {
  for(const field of context.fields){field.title=`Previous ${field.name}`;delete field.description;}
  return context;
}

test('field title and description changes reuse completed images and preserve original context hashes',async t=>{
  const f=await fixture(t),bridge=currentListingBridge(f);bridge.project(olderFieldMetadata);
  const first=await f.run();assert.equal(first.workflow.status,'COMPLETED',first.workflow.error??'');
  const original=structuredClone(first.workflow),before=f.calls.length;
  bridge.project(context=>context);
  const resumed=await f.run();
  assert.equal(resumed.workflow.id,first.workflow.id);assert.equal(resumed.workflow.status,'COMPLETED');
  assert.equal(f.calls.length,before,'metadata alone must not cause provider calls');
  assert.deepEqual(resumed.workflow.imageContext,original.imageContext);assert.equal(resumed.workflow.contextSha256,original.contextSha256);
  const rechecked=await f.service.recheck({draftId:f.draft.id,draftRevision:f.draft.revision,sourceWorkflowId:first.workflow.id});
  assert.equal(rechecked.workflow.approvalReuse?.sourceRunId,first.workflow.id);
  assert.equal(f.calls.length,before);assert.deepEqual(rechecked.workflow.imageContext,original.imageContext);
  assert.equal(rechecked.workflow.contextSha256,original.contextSha256);
});

test('field metadata changes preserve unknown history while retrying only the missing request',async t=>{
  const f=await fixture(t,{generationError:true}),bridge=currentListingBridge(f);bridge.project(olderFieldMetadata);
  const first=await f.run(),attempt=first.workflow.slots![0].attempts[0];assert.equal(attempt.state,'UNKNOWN');
  bridge.project(context=>context);await f.service.close();const restarted=f.reopen();
  try{
    const resumed=await restarted.complete({draftId:f.draft.id,draftRevision:f.draft.revision});
    assert.equal(resumed.workflow.id,first.workflow.id);assert.equal(resumed.workflow.slots![0].status,'UNKNOWN');
    assert.equal(resumed.workflow.slots![0].attempts.length,2);assert.equal(resumed.workflow.slots![0].attempts[0].requestId,attempt.requestId);
    assert.equal(f.calls.filter(call=>call==='generate').length,2);
  }finally{await restarted.close();}
});

test('semantic field and source changes still block the original unknown paid workflow',async t=>{
  const changes:Record<string,(context:ListingAiContext)=>void>={
    'allowed values':c=>{c.fields[0].allowedValues.push('Changed option');},
    'field permissions':c=>{c.fields[0].requirement=c.fields[0].requirement==='required'?'optional':'required';},
    'field bounds':c=>{c.fields[0].maxLength=(c.fields[0].maxLength??0)+1;},
    'field collection':c=>{c.fields.pop();},
    'source evidence':c=>{c.evidence.push({id:randomUUID(),name:'Color',value:'Red',meaning:'color',source:'source_confirmed'});},
    'identity':c=>{c.targetGeneration++;},
    'schema':c=>{c.schemaSha256='f'.repeat(64);},
  };
  for(const [label,change] of Object.entries(changes)){
    const f=await fixture(t,{lostResponse:true}),bridge=currentListingBridge(f),first=await f.run();
    assert.equal(first.workflow.slots![0].status,'UNKNOWN');
    bridge.project(context=>{context.fields[0].description='New metadata';change(context);return context;});
    const next=await f.run();assert.equal(next.workflow.status,'BLOCKED',label);assert.equal(next.workflow.id,first.workflow.id);
    assert.equal(next.workflow.slots![0].attempts[0].requestId,first.workflow.slots![0].attempts[0].requestId);
    assert.equal(next.workflow.slots![0].attempts.length,1);assert.equal(f.calls.filter(call=>call==='generate').length,1,label);
  }
});

test('field metadata compatibility preserves exact rule-filter evidence hashes and source bytes',async t=>{
  const f=await fixture(t,{ipVerdict:'BLOCKED'}),bridge=currentListingBridge(f);bridge.project(olderFieldMetadata);
  const first=await f.run(),proof=await f.service.getRuleFilterEvidence(f.draft.id);assert.ok(proof);
  const before=f.calls.length;bridge.project(context=>context);
  assert.deepEqual(await f.service.getRuleFilterEvidence(f.draft.id),proof);assert.equal(f.calls.length,before);
  const plan=f.ai.getResult(proof.resultId),original=structuredClone(plan.imageContext!);
  plan.imageContext!.listing.fields[0].title='Tampered stored label';
  assert.equal(await f.service.getRuleFilterEvidence(f.draft.id),null,'stored evidence is hashed without normalization');
  plan.imageContext=original;
  assert.deepEqual(await f.service.getRuleFilterEvidence(f.draft.id),proof);
  const asset=f.store.getAssetRecord(first.workflow.referenceAssets[0].id)!;
  await writeFile(join(f.root,asset.originalPath),Buffer.from('changed source bytes'));
  assert.equal(await f.service.getRuleFilterEvidence(f.draft.id),null);assert.equal(f.calls.length,before);
});

test('approval reuse retains its existing bounded four-field migration exception',async t=>{
  const f=await fixture(t),bridge=currentListingBridge(f),first=await f.run();assert.equal(first.workflow.status,'COMPLETED');
  const count=f.calls.length;
  bridge.project(context=>{
    for(const name of ['theme','subject_character','blade','target_audience'] as const)if(!context.fields.some(field=>field.name===name))
      context.fields.push({name,title:`New ${name}`,description:'Newly supported catalog help',requirement:'optional',closedEnum:false,allowedValues:[],suggestedValues:[]});
    return context;
  });
  const next=await f.service.recheck({draftId:f.draft.id,draftRevision:f.draft.revision,sourceWorkflowId:first.workflow.id});
  assert.equal(next.workflow.approvalReuse?.sourceRunId,first.workflow.id);assert.equal(f.calls.length,count);
  assert.deepEqual(next.workflow.imageContext,first.workflow.imageContext);assert.equal(next.workflow.contextSha256,first.workflow.contextSha256);
});
test('copy review switch skips independent copy review while preserving main text and risk checks',async t=>{
  const f=await fixture(t);assert.equal(f.service.getCopyReviewSettings().enabled,true);
  f.service.saveCopyReviewSettings({enabled:false});
  f.listing.reviewCurrentForImages=async()=>{throw Error('copy reviewer must not be called');};
  const result=await f.run();assert.equal(result.workflow.status,'COMPLETED',result.workflow.error??'');
  assert.equal(result.workflow.copyReviewEnabled,false);assert.equal(result.workflow.imageContext?.listingReviewResultId,null);
  assert.equal(result.workflow.imageContext?.copyReviewBypass?.policy,'copy-review-disabled/v1');
  assert.equal(f.calls.includes('content-review'),false);assert.equal(f.calls.filter(c=>c==='review').length,1);assert.equal(f.calls.filter(c=>c==='ip-check').length,7);
  await f.service.close();const restarted=f.reopen();
  try{assert.deepEqual(restarted.getCopyReviewSettings(),{enabled:false});assert.equal(restarted.getProgress(f.draft.id)?.status,'COMPLETED');
    const db=openDatabase(f.root);try{assert.equal(approvedWorkflowAssets(db,f.amazon.getDraft(f.draft.id),f.store.getProduct(f.product.id))?.length,7);restarted.saveCopyReviewSettings({enabled:true});assert.throws(()=>approvedWorkflowAssets(db,f.amazon.getDraft(f.draft.id),f.store.getProduct(f.product.id)),/文案/);}finally{db.close();}
  }finally{await restarted.close();}
});

for(const mode of ['plan','generated','uncertain','service-error'] as const)test(`read-only filtering proof requires successful exact BLOCKED evidence: ${mode}`,async t=>{
  const f=await fixture(t,{ipVerdict:mode==='plan'?'BLOCKED':mode==='uncertain'?'UNCERTAIN':'PASS',generatedRisk:mode==='generated',riskFailure:mode==='service-error'});
  const calls=new Map<string,AiCall>();
  const seal=(result:AiResult,context:ProductImageContext,providerId:any)=>{
    Object.assign(result,{providerId,productId:f.product.id,productRevision:f.product.revision,variantId:f.draft.variantId,model:'fixture',createdAt:new Date().toISOString(),imageContext:structuredClone(context),sourceSha256:listingFingerprint(context)});
    calls.set(result.callId,{id:result.callId,providerId,productId:result.productId,productRevision:result.productRevision,model:result.model,status:'SUCCEEDED',finishedAt:result.createdAt} as AiCall);return result;
  };
  const plan=f.ai.imagePlan,risk=f.ai.reviewGeneratedImageRisk;
  f.ai.imagePlan=async context=>seal(await plan(context),context,'deepseek');
  f.ai.reviewGeneratedImageRisk=async(context,plan,candidate)=>seal(await risk(context,plan,candidate),context as ProductImageContext,'aliyun-image-risk');
  (f.ai as any).getCall=(id:string)=>calls.get(id);
  const runResult=await f.run();assert.ok(runResult.workflow.setPlanResultId,runResult.workflow.error??'set plan missing');const before=[...f.calls],proof=await (f.service as any).getRuleFilterEvidence(f.draft.id);
  assert.equal(Boolean(proof),mode==='plan'||mode==='generated');assert.deepEqual(f.calls,before,'proof never sends a provider call');
  if(proof){
    assert.equal(proof.kind,mode==='plan'?'IP_PLAN_BLOCKED':'IP_IMAGE_BLOCKED');
    const call=calls.get(proof.callId)!;call.status='FAILED';assert.equal(await (f.service as any).getRuleFilterEvidence(f.draft.id),null);call.status='SUCCEEDED';
    f.service.saveRiskSettings({enabled:false});assert.equal(await (f.service as any).getRuleFilterEvidence(f.draft.id),null);f.service.saveRiskSettings({enabled:true});
    const asset=f.store.getAssetRecord(f.product.assets[0].id)!;await writeFile(join(f.root,asset.originalPath),Buffer.from('changed bytes'));
    assert.equal(await (f.service as any).getRuleFilterEvidence(f.draft.id),null,'same metadata cannot preserve a screen after reference bytes change');
  }
});
test('disabling copy review resumes a draft whose two current-copy repairs were exhausted',async t=>{
  const f=await fixture(t),original=f.listing.reviewCurrentForImages;
  f.listing.reviewCurrentForImages=async()=>{const copy=await original();(copy.review.output as any).verdict='NEEDS_CHANGES';return copy;};
  let repairs=0;(f.listing as any).repairCurrentForImages=async()=>{repairs++;return {draft:f.amazon.getDraft(f.draft.id),aiCalls:1,remaining:['color review too strict'],blocked:false};};
  const blocked=await f.run();assert.equal(blocked.workflow.status,'BLOCKED');assert.equal(repairs,2);
  f.service.saveCopyReviewSettings({enabled:false});const before=f.calls.length,next=await f.run();
  assert.equal(next.workflow.status,'COMPLETED',next.workflow.error??'');assert.equal(repairs,2);assert.equal(next.workflow.copyRepairAttempts,2);assert.equal(next.workflow.copyReviewResultId,blocked.workflow.copyReviewResultId);
  assert.equal(f.calls.slice(before).includes('content-review'),false);assert.equal(next.workflow.imageContext?.listingReviewResultId,null);
});
test('reenabling copy review checks an existing completed set without generating new images',async t=>{
  const f=await fixture(t);f.service.saveCopyReviewSettings({enabled:false});const first=await f.run();assert.equal(first.workflow.status,'COMPLETED');
  f.service.saveCopyReviewSettings({enabled:true});const before=f.calls.length,next=await f.run();
  assert.equal(next.workflow.status,'COMPLETED',next.workflow.error??'');assert.equal(next.workflow.recheckedFromRunId,first.workflow.id);assert.equal(f.calls.slice(before).includes('generate'),false);assert.equal(f.calls.slice(before).includes('content-review'),true);assert.ok(next.workflow.imageContext?.listingReviewResultId);
});
test('reenabling before any copy snapshot does not retain an unused bypass marker',async t=>{
  const f=await fixture(t,{configured:false});f.service.saveCopyReviewSettings({enabled:false});const first=await f.run();assert.equal(first.workflow.status,'BLOCKED');assert.equal(first.workflow.imageContext,undefined);
  const connection=f.generation.getConnection();f.generation.getConnection=()=>({...connection,configured:true});f.service.saveCopyReviewSettings({enabled:true});
  const next=await f.run();assert.equal(next.workflow.status,'COMPLETED');assert.notEqual(next.workflow.copyReviewEnabled,false);assert.equal(f.service.isCopyReviewPolicyCompatible(next.workflow),true);
});
test('risk switch persists independently and disabled mode preserves main OCR without risk calls',async t=>{
  const f=await fixture(t,{ipVerdict:'UNCERTAIN',riskFailure:true});
  assert.equal(f.service.getRiskSettings().enabled,true);
  f.service.saveRiskSettings({enabled:false});
  const profiles:string[]=[];f.ai.getProfile=((id:string)=>{profiles.push(id);return {enabled:id!=='aliyun-image-risk',configured:id!=='aliyun-image-risk',generation:1};}) as typeof f.ai.getProfile;
  const result=await f.run();
  assert.equal(result.workflow.status,'COMPLETED',result.workflow.error??'');
  assert.equal(result.workflow.riskInterceptionEnabled,false);
  assert.equal(f.calls.filter(c=>c==='ip-check').length,0);
  assert.equal(f.calls.filter(c=>c==='ocr').length,1);
  assert.equal(f.calls.filter(c=>c==='review').length,1);
  assert.ok(!profiles.includes('aliyun-image-risk'));
  assert.ok(result.workflow.slots!.every(slot=>slot.attempts.at(-1)!.riskBypass?.candidate.sha256===slot.approvedSha256));
  const again=f.reopen();try{assert.equal(again.getRiskSettings().enabled,false);assert.equal(again.getProgress(f.draft.id)?.status,'COMPLETED');}finally{await again.close();}
  const db=openDatabase(f.root);try{assert.equal(approvedWorkflowAssets(db,f.amazon.getDraft(f.draft.id),f.store.getProduct(f.product.id))?.length,7);f.service.saveRiskSettings({enabled:true});assert.throws(()=>approvedWorkflowAssets(db,f.amazon.getDraft(f.draft.id),f.store.getProduct(f.product.id)),/风险/);}finally{db.close();}
});

test('turning risk off resumes a previously blocked candidate without regenerating it',async t=>{
  const f=await fixture(t,{generatedRisk:true}),first=await f.run();
  assert.equal(first.workflow.slots![0].status,'BLOCKED');const candidate=first.workflow.slots![0].attempts[0].candidateId;
  f.service.saveRiskSettings({enabled:false});const next=await f.run();
  assert.equal(next.workflow.status,'COMPLETED',next.workflow.error??'');
  assert.equal(next.workflow.slots![0].attempts[0].candidateId,candidate);
  assert.equal(f.calls.filter(c=>c==='generate').length,7);
  assert.equal(f.calls.filter(c=>c==='ip-check').length,1);
  assert.equal(f.ai.getResult(next.workflow.slots![0].attempts[0].ipReviewResultId!).output.kind,'image-ip-review');
});

test('risk off never bypasses an unreadable product or main text rejection',async t=>{
  const f=await fixture(t,{insufficient:true});f.service.saveRiskSettings({enabled:false});
  assert.equal((await f.run()).workflow.status,'BLOCKED');assert.ok(!f.calls.includes('generate'));
  const g=await fixture(t,{rejectSlot:1});g.service.saveRiskSettings({enabled:false});
  const rejected=await g.run();assert.equal(rejected.workflow.slots![0].status,'FAILED');assert.equal(rejected.workflow.slots!.filter(s=>s.status==='PASSED').length,6);
});

test('reenabling risk never rewrites the provenance of an interrupted disabled workflow',async t=>{
  const f=await fixture(t,{ipVerdict:'UNCERTAIN',generationError:true});f.service.saveRiskSettings({enabled:false});
  const first=await f.run();assert.equal(first.workflow.riskInterceptionEnabled,false);assert.equal(first.workflow.slots![0].attempts[0].state,'UNKNOWN');
  f.service.saveRiskSettings({enabled:true});assert.throws(()=>f.run(),/未完成|完成该套/);
  assert.deepEqual(f.service.getProgress(f.draft.id),first.workflow);
});

test('unknown generation automatically retries missing step with three durable attempts',async t=>{
  const options={generationError:true},f=await fixture(t,options),first=await f.run(),attempt=first.workflow.slots![0].attempts[0];
  assert.ok(attempt,first.workflow.error??JSON.stringify(first));assert.equal(attempt.state,'UNKNOWN');await f.run();await f.run();await f.run();
  const stopped=f.service.getProgress(f.draft.id)!;
  assert.equal(f.calls.filter(c=>c==='generate').length,3);assert.equal(stopped.slots![0].attempts.length,3);
  assert.equal(stopped.slots![0].attempts[0].requestId,attempt.requestId);
  options.generationError=false;await f.run();assert.equal(f.calls.filter(c=>c==='generate').length,3);

});

test('legacy completed field checkpoint receives one supported repair and is not paid repeatedly',async t=>{
  const f=await fixture(t);let count=0;
  f.listing.complete=async()=>{count++;return {draft:f.amazon.getDraft(f.draft.id),aiCalls:1,previewAttempts:0,remaining:['theme missing']};};
  const first=await f.run();const db=openDatabase(f.root);
  const raw=JSON.parse(String(db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(f.draft.id)?.record_json??'null'));
  assert.ok(raw);raw.draft.localIssues=[{code:'LOCAL_required',message:'theme missing',severity:'ERROR',attributeNames:['theme'],category:'field',source:'local',autoFixable:false}];
  db.prepare('UPDATE listing_drafts SET record_json=? WHERE id=?').run(JSON.stringify(raw),f.draft.id);
  const saved=structuredClone(first.workflow);delete saved.contentPreparation!.repairPolicyVersion;
  db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(JSON.stringify(saved),saved.id);db.close();
  await f.run();assert.equal(count,2);await f.run();assert.equal(count,2);
  assert.equal(f.service.getProgress(f.draft.id)?.contentPreparation?.repairPolicyVersion,'field-evidence/v2');
});

for(const interrupted of [false,true])test(`category migration repairs an old v2 content checkpoint once (${interrupted?'unknown':'known'} result)`,async t=>{
  const f=await fixture(t);f.service.saveCopyReviewSettings({enabled:false});let repairs=0;
  f.listing.complete=async()=>{repairs++;return {draft:f.amazon.getDraft(f.draft.id),aiCalls:1,previewAttempts:0,remaining:['age_range_description: required']};};
  const first=await f.run(),db=openDatabase(f.root),old=structuredClone(first.workflow) as any;delete old.categoryFieldPolicyVersion;
  db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(JSON.stringify(old),old.id);db.close();
  if(interrupted)f.listing.complete=async()=>{repairs++;throw new AiError('NETWORK_ERROR');};
  const next=await f.run();assert.equal(repairs,2);assert.equal(next.workflow.id,first.workflow.id);assert.deepEqual((next.workflow as any).categoryFieldRepair?.fields,['age_range_description']);
  for(const change of ['grant','field','version','policy','date'] as const){const bad=structuredClone(next.workflow) as any;if(change==='grant')bad.categoryFieldRepair.grantedAttempts=2;if(change==='field')bad.categoryFieldRepair.fields=['color'];if(change==='version')bad.categoryFieldRepair.version='other';if(change==='policy')delete bad.categoryFieldPolicyVersion;if(change==='date')bad.categoryFieldRepair.grantedAt='tomorrow';assert.throws(()=>validateImageWorkflowRun(bad));}
  await f.service.close();const restored=f.reopen();try{const again=await restored.complete({draftId:f.draft.id,draftRevision:f.draft.revision});assert.equal(repairs,2);assert.equal(again.workflow.contentPreparation?.state,interrupted?'STARTED':'DONE');assert.ok(!f.calls.includes('generate'));}finally{await restored.close();}
});

test('category migration repairs and resumes old seven images without a color observation',async t=>{
  const f=await fixture(t);f.service.saveCopyReviewSettings({enabled:false});const first=await f.run(),db=openDatabase(f.root);
  try{const old=structuredClone(first.workflow) as any;delete old.categoryFieldPolicyVersion;db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(JSON.stringify(old),old.id);
    const raw=JSON.parse(String(db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(f.draft.id)!.record_json));raw.draft.localIssues=[{code:'LOCAL_required',message:'Age range missing',severity:'ERROR',attributeNames:['age_range_description'],category:'field',source:'local',autoFixable:false}];db.prepare('UPDATE listing_drafts SET record_json=? WHERE id=?').run(JSON.stringify(raw),f.draft.id);
    let repairs=0;f.listing.complete=async()=>{repairs++;const draft=f.amazon.getDraft(f.draft.id);return {draft:f.amazon.saveDraft({id:draft.id,revision:draft.revision,attributes:{...draft.attributes,age_range_description:[{value:'Adult',marketplace_id:draft.marketplaceId}]}}),aiCalls:1,previewAttempts:0,remaining:[]};};
    const snapshot=f.listing.snapshotCurrentForImages;f.listing.snapshotCurrentForImages=async()=>{f.service.cancel(f.draft.id);throw new AiError('CANCELLED');};
    const count=f.calls.length,stopped=await f.run();assert.equal(repairs,1);assert.equal(stopped.workflow.contentPreparation?.state,'DONE');assert.equal(stopped.workflow.imageContext,undefined);
    const input={draftId:f.draft.id,draftRevision:stopped.draft.revision,sourceWorkflowId:first.workflow.id};assert.equal(f.service.canResumeRecheckDraft(input),true);
    f.listing.snapshotCurrentForImages=snapshot;await f.service.close();const restored=f.reopen();try{const result=await restored.recheck(input);assert.equal(result.workflow.status,'COMPLETED',result.workflow.error??'');assert.equal(repairs,1);assert.deepEqual(result.workflow.slots!.map(s=>s.approvedAssetId),first.workflow.slots!.map(s=>s.approvedAssetId));assert.ok(!f.calls.slice(count).includes('generate'));assert.deepEqual(JSON.parse(String(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(first.workflow.id)!.record_json)),old);}finally{await restored.close();}
  }finally{db.close();}
});

test('complete chain adopts seven SKU images without invalidating source/draft revisions and reuses them',async t=>{
  const f=await fixture(t), before=f.product.revision, result=await f.run();
  assert.equal(result.workflow.status,'COMPLETED',JSON.stringify({stage:result.workflow.stage,error:result.workflow.error,calls:f.calls})); assert.deepEqual(f.calls,['content','content-review','source-ocr','set-plan','plan','generate','ip-check','ocr','review',...Array.from({length:6},()=>['plan','generate','ip-check']).flat()]);
  assert.equal(result.workflow.slots?.filter(slot=>slot.status==='PASSED').length,7);
  assert.equal(result.workflow.imagePolicyVersion,PRODUCT_IMAGE_POLICY_VERSION);
  assert.deepEqual(f.generationInputs[0].referenceAssetIds,result.workflow.referenceAssets.map(asset=>asset.id));
  assert.match(f.generationInputs[0].prompt,/blue round coaster/); assert.match(f.generationInputs[0].prompt,/Exact size is unknown/); assert.match(f.generationInputs[0].prompt,/Show this product/);
  assert.equal(f.store.getProduct(f.product.id).revision,before);
  const asset=f.store.getAssetRecord(result.workflow.approvedAssetId!)!; assert.equal(hash(await readFile(join(f.root,asset.originalPath))),result.workflow.approvedSha256);
  const db=openDatabase(f.root); try{assert.equal(approvedWorkflowAsset(db,f.amazon.getDraft(f.draft.id),f.store.getProduct(f.product.id))!.id,asset.id);assert.equal(approvedWorkflowAssets(db,f.amazon.getDraft(f.draft.id),f.store.getProduct(f.product.id))!.length,7);}finally{db.close();}
  assert.equal((await f.run()).workflow.id,result.workflow.id); assert.equal(f.calls.length,27);
});
test('seven paid outputs remain intact while new source proof is pending and reuse without regeneration after explicit proof',async t=>{
  const f=await fixture(t),first=await f.run(),ids=first.workflow.slots!.map(slot=>slot.approvedAssetId),count=f.calls.filter(c=>c==='generate').length;
  const db=openDatabase(f.root);try{db.prepare('DELETE FROM source_consistency_decisions').run();}finally{db.close();}
  assert.throws(()=>f.run(),SourceConsistencyError);assert.deepEqual(f.service.getProgress(f.draft.id)!.slots!.map(slot=>slot.approvedAssetId),ids);assert.equal(f.calls.filter(c=>c==='generate').length,count);
  await confirmSourceConsistencyFixture(f.root,f.store,f.product.id);
  const resumed=await f.run();assert.equal(resumed.workflow.id,first.workflow.id);assert.deepEqual(resumed.workflow.slots!.map(slot=>slot.approvedAssetId),ids);assert.equal(f.calls.filter(c=>c==='generate').length,count);
});
test('known review rejection repairs once, while persistent failure never adopts',async t=>{
  const f=await fixture(t,{rejected:1}), result=await f.run(); assert.equal(result.workflow.status,'COMPLETED'); assert.equal(result.workflow.slots![0].attempts.length,2);
  const g=await fixture(t,{rejectSlot:1}), blocked=await g.run(); assert.equal(blocked.workflow.status,'BLOCKED'); assert.equal(blocked.workflow.slots![0].attempts.length,3); assert.equal(g.calls.filter(c=>c==='generate').length,9);
  assert.equal(blocked.workflow.slots!.filter(slot=>slot.status==='PASSED').length,6);
  const ids=blocked.workflow.slots!.map(slot=>slot.approvedAssetId);await g.service.close();const restarted=g.reopen();
  const again=await restarted.complete({draftId:g.draft.id,draftRevision:g.amazon.getDraft(g.draft.id).revision});
  assert.deepEqual(again.workflow.slots!.map(slot=>slot.approvedAssetId),ids);assert.equal(g.calls.filter(c=>c==='generate').length,9);await restarted.close();
});

async function reopenWithLegacyTextReviews(f: Awaited<ReturnType<typeof fixture>>, runId: string) {
  await f.service.close();
  const db = openDatabase(f.root);
  try {
    const row = db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(runId)!;
    const run = JSON.parse(String(row.record_json));
    for (const slot of run.slots) for (const attempt of slot.attempts) delete attempt.textReviewPolicyVersion;
    db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(JSON.stringify(run), runId);
  } finally { db.close(); }
  return f.reopen();
}

test('a new text policy rechecks only the last exhausted candidate once without new generation, IP or OCR', async t => {
  for (const verdict of ['PASS', 'NEEDS_CHANGES'] as const) {
    const f = await fixture(t, { rejectSlot: 1 }), first = await f.run();
    assert.equal(first.workflow.slots![0].attempts.length, 3);
    const originals = first.workflow.slots!.map(slot => slot.approvedAssetId), saved = first.workflow.slots![0].attempts[2];
    const review = f.ai.reviewGeneratedImage;
    f.ai.reviewGeneratedImage = async (...args) => {
      const result = await review(...args);
      if (result.output.kind !== 'image-text-review') throw Error('Unexpected review');
      result.output.verdict = verdict; result.output.issues = verdict === 'PASS' ? [] : ['Unwanted factual text remains.'];
      return result;
    };
    const restarted = await reopenWithLegacyTextReviews(f, first.workflow.id);
    try {
      assert.equal(canResumeImageWorkflow(restarted.getProgress(f.draft.id)), true);
      const count = f.calls.length, resumed = await restarted.complete({ draftId: f.draft.id, draftRevision: f.draft.revision });
      assert.deepEqual(f.calls.slice(count), ['review']);
      assert.equal(resumed.workflow.status, verdict === 'PASS' ? 'COMPLETED' : 'BLOCKED');
      assert.equal(resumed.workflow.attempt, first.workflow.attempt); assert.equal(resumed.workflow.slots![0].attempts.length, 3);
      const last = resumed.workflow.slots![0].attempts[2];
      for (const key of ['requestId', 'candidateId', 'planResultId', 'ipReviewResultId', 'ocrResultId'] as const) assert.equal(last[key], saved[key]);
      assert.notEqual(last.reviewResultId, saved.reviewResultId);
      assert.equal((last as any).textReviewPolicyVersion, 'image-text-review/v2');
      for (const [index, id] of originals.entries()) if (index !== 0) assert.equal(resumed.workflow.slots![index].approvedAssetId, id);
      assert.equal(canResumeImageWorkflow(resumed.workflow), false);
      const againCount = f.calls.length;
      await restarted.complete({ draftId: f.draft.id, draftRevision: f.draft.revision });
      assert.equal(f.calls.length, againCount);
    } finally { await restarted.close(); }
  }
});

test('an uncertain policy recheck response is consumed durably and never automatically paid again', async t => {
  const f = await fixture(t, { rejectSlot: 1 }), first = await f.run();
  const restarted = await reopenWithLegacyTextReviews(f, first.workflow.id);
  f.ai.reviewGeneratedImage = async () => { f.calls.push('review'); throw new AiError('NETWORK_ERROR'); };
  try {
    const count = f.calls.length, result = await restarted.complete({ draftId: f.draft.id, draftRevision: f.draft.revision });
    assert.deepEqual(f.calls.slice(count), ['review']); assert.equal(result.workflow.status, 'FAILED');
    assert.equal(result.workflow.slots![0].attempts[2].reviewResultId, first.workflow.slots![0].attempts[2].reviewResultId);
    assert.equal(canResumeImageWorkflow(result.workflow), false);
  } finally { await restarted.close(); }
  const again = f.reopen();
  try { const count = f.calls.length; await again.complete({ draftId: f.draft.id, draftRevision: f.draft.revision }); assert.equal(f.calls.length, count); }
  finally { await again.close(); }
});

test('a successful policy recheck interrupted before adoption resumes from its saved approval without another review', async t => {
  const f = await fixture(t, { rejectSlot: 1 }), first = await f.run();
  const restarted = await reopenWithLegacyTextReviews(f, first.workflow.id), review = f.ai.reviewGeneratedImage;
  f.ai.reviewGeneratedImage = async (...args) => {
    const result = await review(...args);
    if (result.output.kind !== 'image-text-review') throw Error('Unexpected review');
    result.output.verdict = 'PASS'; result.output.issues = [];
    restarted.cancel(f.draft.id); return result;
  };
  try {
    const count = f.calls.length, cancelled = await restarted.complete({ draftId: f.draft.id, draftRevision: f.draft.revision });
    assert.equal(cancelled.workflow.status, 'CANCELLED'); assert.deepEqual(f.calls.slice(count), ['review']);
    const calls = f.calls.length, savedReviewId = cancelled.workflow.slots![0].attempts[2].reviewResultId;
    const resumed = await restarted.complete({ draftId: f.draft.id, draftRevision: f.draft.revision });
    assert.equal(resumed.workflow.status, 'COMPLETED', resumed.workflow.error ?? ''); assert.equal(f.calls.length, calls);
    assert.equal(resumed.workflow.slots![0].attempts[2].reviewResultId, savedReviewId);
  } finally { await restarted.close(); }
});

test('policy recovery cannot re-review IP refusals, blocked text or incomplete saved evidence', async t => {
  for (const invalid of ['ip-blocked', 'text-blocked', 'missing-ocr'] as const) {
    const f = await fixture(t, { rejectSlot: 1 }), first = await f.run(), last = first.workflow.slots![0].attempts[2];
    if (invalid === 'ip-blocked') (f.ai.getResult(last.ipReviewResultId!).output as any).verdict = 'BLOCKED';
    if (invalid === 'text-blocked') (f.ai.getResult(last.reviewResultId!).output as any).verdict = 'BLOCKED';
    if (invalid === 'missing-ocr') { const get = f.ai.getResult; f.ai.getResult = id => id === last.ocrResultId ? undefined as never : get(id); }
    const restarted = await reopenWithLegacyTextReviews(f, first.workflow.id);
    try { const count = f.calls.length; const result = await restarted.complete({ draftId: f.draft.id, draftRevision: f.draft.revision }); assert.equal(f.calls.length, count); assert.notEqual(result.workflow.status, 'COMPLETED'); }
    finally { await restarted.close(); }
  }
});

test('current-policy exhausted refusals do not qualify for another text review', async t => {
  const f = await fixture(t, { rejectSlot: 1 }), first = await f.run(), count = f.calls.length;
  assert.equal((first.workflow.slots![0].attempts[2] as any).textReviewPolicyVersion, 'image-text-review/v2');
  assert.equal(canResumeImageWorkflow(first.workflow), false);
  await f.run(); assert.equal(f.calls.length, count);
});
test('known generation failure and OCR repair share the same three attempts per slot',async t=>{
  const f=await fixture(t,{knownGenerationFailures:1,rejected:1}),result=await f.run();
  assert.equal(result.workflow.status,'COMPLETED');assert.equal(result.workflow.slots![0].attempts.length,3);assert.equal(f.calls.filter(call=>call==='generate').length,9);
});

test('final copy repair rechecks the existing image with new IP and OCR evidence and no extra generation',async t=>{
  const f=await fixture(t),first=await f.run(),before=f.store.getProduct(f.product.id).assets.length;
  const changed=f.amazon.saveDraft({id:f.draft.id,revision:f.amazon.getDraft(f.draft.id).revision,attributes:{...f.amazon.getDraft(f.draft.id).attributes,item_name:[{value:'Updated storage bag',marketplace_id:'ATVPDKIKX0DER',language_tag:'en_US'}]}});
  f.generation.configurationScope=()=>{throw new AiError('NOT_CONFIGURED');};
  f.generation.getConnection=()=>{throw new AiError('NOT_CONFIGURED');};
  const result=await f.service.recheck({draftId:changed.id,draftRevision:changed.revision,sourceWorkflowId:first.workflow.id});
  assert.equal(result.workflow.status,'COMPLETED');assert.notEqual(result.workflow.id,first.workflow.id);
  assert.equal(result.workflow.approvedAssetId,first.workflow.approvedAssetId);
  assert.equal(f.calls.filter(call=>call==='generate').length,7);
  assert.equal(f.calls.filter(call=>call==='ip-check').length,14);assert.equal(f.calls.filter(call=>call==='ocr').length,2);
  assert.equal(f.store.getProduct(f.product.id).assets.length,before);
  const db=openDatabase(f.root);
  try{assert.equal(approvedWorkflowAsset(db,f.amazon.getDraft(changed.id),f.store.getProduct(f.product.id))!.id,first.workflow.approvedAssetId);}finally{db.close();}
});

test('same-ID NONE to CHILD migration rechecks all seven images with unchanged candidates, assets and legacy recipe',async t=>{
  const f=await fixture(t,{familyMigration:true}),first=await f.run();
  assert.equal(first.workflow.status,'COMPLETED',first.workflow.error??'');assert.ok(f.familyPlan);
  const before=f.amazon.getDraft(f.draft.id),assets=f.store.getProduct(f.product.id).assets;
  assert.equal(first.workflow.imageRecipeSha256,listingFingerprint(before.salesPlan!.recipe));
  const originalSchema=f.amazon.getSchema.bind(f.amazon);
  f.amazon.getSchema=async input=>{
    const value=await originalSchema(input);if(value.parentageLevel!=='CHILD')return value;
    const fields=value.schema.properties as JsonObject,marketplace_id={type:'string',const:before.marketplaceId};
    fields.parentage_level={type:'array',items:{type:'object',properties:{value:{const:'child'},marketplace_id},required:['value','marketplace_id'],additionalProperties:false}};
    fields.variation_theme={type:'array',items:{type:'object',properties:{name:{enum:['COLOR']},marketplace_id},required:['name','marketplace_id'],additionalProperties:false}};
    fields.child_parent_sku_relationship={type:'array',items:{type:'object',properties:{child_relationship_type:{const:'variation'},parent_sku:{type:'string'},marketplace_id},required:['child_relationship_type','parent_sku','marketplace_id'],additionalProperties:false}};
    value.checksum=createHash('md5').update(JSON.stringify(value.schema)).digest('base64');value.version+='-family';return value;
  };
  const child=await f.amazon.rebindUnsubmittedFamily({id:before.id,revision:before.revision,plan:f.familyPlan});
  assert.equal(child.id,before.id);assert.equal(child.sku,before.sku);assert.deepEqual(child.salesPlan!.recipe,before.salesPlan!.recipe);
  assert.equal(child.schema.parentageLevel,'CHILD');assert.notEqual(child.schema.checksum,before.schema.checksum);
  assert.notEqual(imageWorkflowDraftStamp(child),first.workflow.draftSha256);
  const db=openDatabase(f.root);
  try{
    assert.throws(()=>approvedWorkflowAssets(db,child,f.store.getProduct(f.product.id)),/变化|重新/);
    f.generation.configurationScope=()=>{throw Error('A relationship migration cannot use the image provider');};
    f.generation.getConnection=()=>{throw Error('A relationship migration cannot use the image provider');};
    const count=f.calls.length,rechecked=await f.service.recheck({draftId:child.id,draftRevision:child.revision,sourceWorkflowId:first.workflow.id});
    assert.equal(rechecked.workflow.status,'COMPLETED',rechecked.workflow.error??'');assert.equal(rechecked.workflow.recheckedFromRunId,first.workflow.id);
    assert.deepEqual(rechecked.workflow.slots!.map(slot=>({assetId:slot.approvedAssetId,sha256:slot.approvedSha256,candidates:slot.attempts.map(attempt=>attempt.candidateId)})),
      first.workflow.slots!.map(slot=>({assetId:slot.approvedAssetId,sha256:slot.approvedSha256,candidates:slot.attempts.map(attempt=>attempt.candidateId)})));
    assert.deepEqual(f.store.getProduct(f.product.id).assets,assets);assert.equal(f.calls.filter(call=>call==='generate').length,7);assert.ok(!f.calls.slice(count).includes('generate'));
    assert.equal(rechecked.workflow.imageRecipeSha256,first.workflow.imageRecipeSha256);
    assert.equal(rechecked.workflow.draftSha256,imageWorkflowDraftStamp(f.amazon.getDraft(child.id)));
    assert.equal(rechecked.workflow.imageContext!.listing.parentageLevel,'CHILD');
    assert.deepEqual(rechecked.workflow.imageContext!.listing,buildListingContext(f.amazon.getDraft(child.id),f.store.getProduct(f.product.id),f.amazon.executionTargetScope(child.targetId).generation));
    assert.deepEqual(approvedWorkflowAssets(db,f.amazon.getDraft(child.id),f.store.getProduct(f.product.id)),first.workflow.slots!.map(slot=>({id:slot.approvedAssetId,sha256:slot.approvedSha256})));
    const old=JSON.parse(String(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(first.workflow.id)!.record_json));
    assert.deepEqual(old,first.workflow);
  }finally{db.close();}
});

test('blocked recheck records the repaired draft version and resumes the original seven images with copy review off',async t=>{
  const f=await fixture(t),first=await f.run(),originalReview=f.listing.reviewCurrentForImages;
  assert.equal(first.workflow.status,'COMPLETED',first.workflow.error??'');
  const changed=f.amazon.saveDraft({id:f.draft.id,revision:f.draft.revision,attributes:{...f.draft.attributes,item_name:[{value:'Field repair title',marketplace_id:'ATVPDKIKX0DER',language_tag:'en_US'}]}});
  const calls=new Map<string,AiCall>();
  const snapshotCurrent=async()=>{const draft=f.amazon.getDraft(f.draft.id);return currentImageListingSnapshot(draft,buildListingContext(draft,f.store.getProduct(draft.productId),f.amazon.executionTargetScope(draft.targetId).generation));};
  f.listing.snapshotCurrentForImages=snapshotCurrent as typeof f.listing.snapshotCurrentForImages;
  f.listing.reviewCurrentForImages=async()=>{
    const prior=await originalReview(),snapshot=await snapshotCurrent(),at=new Date().toISOString(),draft=f.amazon.getDraft(f.draft.id);
    Object.assign(prior.review,{providerId:'deepseek-review',productId:draft.productId,productRevision:draft.productRevision,variantId:draft.variantId,model:'fixture-review',createdAt:at,
      sourceSha256:listingFingerprint(snapshot.context),listingContext:snapshot.context,
      output:{kind:'listing-current-review',verdict:'NEEDS_CHANGES',currentListingCopy:snapshot.currentListingCopy,copySha256:listingFingerprint(snapshot.currentListingCopy),checks:[],issues:[]}});
    calls.set(prior.review.callId,{id:prior.review.callId,providerId:'deepseek-review',productId:draft.productId,productRevision:draft.productRevision,status:'SUCCEEDED',errorCode:null,requestId:null,model:'fixture-review',generation:1,startedAt:at,finishedAt:at,usage:{promptTokens:1,completionTokens:1,processedImages:0}});
    return {...snapshot,review:prior.review};
  };
  (f.ai as any).getCall=(id:string)=>calls.get(id);
  let repairs=0;
  (f.listing as any).repairCurrentForImages=async()=>{
    repairs++;const current=f.amazon.getDraft(f.draft.id),draft=f.amazon.saveDraft({id:current.id,revision:current.revision,attributes:{...current.attributes,item_name:[{value:`Recheck copy ${repairs}`,marketplace_id:'ATVPDKIKX0DER',language_tag:'en_US'}]}});
    return {draft,aiCalls:1,remaining:['color needs changes'],blocked:false,review:await f.listing.reviewCurrentForImages()};
  };
  const blocked=await f.service.recheck({draftId:changed.id,draftRevision:changed.revision,sourceWorkflowId:first.workflow.id});
  assert.equal(blocked.workflow.status,'BLOCKED');assert.equal(blocked.workflow.draftSha256,null);assert.equal(blocked.workflow.copyRepairAttempts,2);
  const input={draftId:changed.id,draftRevision:blocked.draft.revision,sourceWorkflowId:first.workflow.id};
  assert.equal(f.service.canResumeRecheckDraft(input),true);assert.equal(f.service.canResumeRecheckDraft({...input,sourceWorkflowId:randomUUID()}),false);
  f.service.saveCopyReviewSettings({enabled:false});await f.service.close();const restored=f.reopen();
  try{
    assert.equal(restored.canResumeRecheckDraft(input),true);
    const resumed=await restored.recheck(input);
    assert.equal(resumed.workflow.status,'COMPLETED',resumed.workflow.error??'');assert.equal(resumed.workflow.id,blocked.workflow.id);
    assert.equal(resumed.workflow.copyRepairAttempts,2);assert.equal(repairs,2);assert.equal(f.calls.filter(call=>call==='generate').length,7);
    assert.deepEqual(resumed.workflow.slots!.map(slot=>slot.approvedAssetId),first.workflow.slots!.map(slot=>slot.approvedAssetId));
  }finally{await restored.close();}
});

test('an internal one-attempt allowance applies independently to each image slot',async t=>{
  const f=await fixture(t,{rejected:99});
  const result=await f.service.complete({draftId:f.draft.id,draftRevision:f.draft.revision},{maxImageAttempts:1});
  assert.equal(result.workflow.status,'BLOCKED');assert.equal(f.calls.filter(call=>call==='generate').length,7);assert.ok(result.workflow.slots!.every(slot=>slot.attempts.length===1));
});

test('known or uncertain IP findings stop before any image generation',async t=>{
  for(const ipVerdict of ['BLOCKED','UNCERTAIN'] as const) {
    const f=await fixture(t,{ipVerdict}), result=await f.run();
    assert.equal(result.workflow.status,'BLOCKED'); assert.match(result.workflow.error!,/Mickey Mouse/);
    assert.equal(f.calls.includes('generate'),false); assert.equal(f.calls.includes('ip-check'),false);
  }
});

test('generated-image risk or unavailable moderation stops without regenerating or adopting',async t=>{
  for(const options of [{generatedRisk:true},{riskFailure:true}]) {
    const f=await fixture(t,options),result=await f.run();
    assert.notEqual(result.workflow.status,'COMPLETED'); assert.equal(result.workflow.approvedAssetId,null);
    assert.equal(f.calls.filter(call=>call==='generate').length,1); assert.equal(f.calls.filter(call=>call==='ip-check').length,1);
    assert.equal(f.calls.includes('ocr'),false);
  }
});

test('unrecognizable references and legacy text-only plans stop before image generation',async t=>{
  const f=await fixture(t,{insufficient:true}), result=await f.run();
  assert.equal(result.workflow.status,'BLOCKED'); assert.equal(result.workflow.stage,'planning');
  assert.match(result.workflow.error!,/来源图片不足以确认/);assert.doesNotMatch(result.workflow.error!,/Selected SKU cannot be identified/);
  assert.deepEqual(f.calls,['content','content-review','source-ocr','set-plan']); assert.equal(f.generationInputs.length,0);
  const g=await fixture(t,{legacyPlan:true}), legacy=await g.run();
  assert.notEqual(legacy.workflow.status,'COMPLETED'); assert.equal(g.calls.includes('generate'),false);
});

test('old completed workflows remain readable but cannot be reused as a vision-reviewed preparation',async t=>{
  const f=await fixture(t), first=await f.run();
  const db=openDatabase(f.root);
  try {
    const {listingEvidenceContractVersion:_evidenceContract,categoryFieldPolicyVersion:_categoryPolicy,categoryFieldRepair:_categoryRepair,copyReviewResultId:_copyReview,contentPreparation:_contentPreparation,imageRecipeSha256:_recipe,copyRepairAttempts:_repairs,approvalReuse:_reuse,slots:_slots,slotPolicy:_policy,imageContext:_context,activeSlot:_active,imagePolicyVersion:_version,ipReviewResultIds:_ip,setPlan:_set,setPlanResultId:_setId,...legacy}=first.workflow;
    Object.assign(legacy,{attempt:1,maxAttempts:1,planResultIds:first.workflow.planResultIds.slice(0,1),candidateIds:first.workflow.candidateIds.slice(0,1),ocrResultIds:first.workflow.ocrResultIds.slice(0,1),reviewResultIds:first.workflow.reviewResultIds.slice(0,1)});
    // Keep the other six paid assets identifiable as generated history when simulating a one-image legacy run.
    const retained={...structuredClone(first.workflow),id:randomUUID(),createdAt:'2020-01-01T00:00:00.000Z',updatedAt:'2020-01-01T00:00:00.000Z'};
    db.prepare('INSERT INTO image_workflow_runs VALUES(?,?)').run(retained.id,JSON.stringify(retained));
    db.prepare('DELETE FROM image_workflow_runs WHERE id=?').run(first.workflow.id);
    db.prepare('INSERT INTO image_workflow_runs VALUES(?,?)').run(first.workflow.id,JSON.stringify(legacy));
    assert.equal(f.service.getProgress(f.draft.id)!.id,first.workflow.id);
    assert.throws(()=>approvedWorkflowAsset(db,f.amazon.getDraft(f.draft.id),f.store.getProduct(f.product.id)),/旧版流程/);
  } finally { db.close(); }
  const second=await f.run(); assert.equal(second.workflow.status,'COMPLETED');
  assert.notEqual(second.workflow.id,first.workflow.id); assert.equal(f.calls.filter(call=>call==='generate').length,14);
});
test('missing configuration stops before paid content; ambiguous timeout retries only after authorized resume',async t=>{
  const f=await fixture(t,{configured:false}); assert.equal((await f.run()).workflow.status,'BLOCKED'); assert.deepEqual(f.calls,[]);
  const g=await fixture(t,{generationError:true}); assert.equal((await g.run()).workflow.status,'FAILED'); assert.equal(g.calls.filter(c=>c==='generate').length,1); assert.equal(g.calls.includes('ocr'),false);
  await g.service.close();const restarted=g.reopen();await restarted.complete({draftId:g.draft.id,draftRevision:g.draft.revision});assert.equal(g.calls.filter(c=>c==='generate').length,2);assert.equal(restarted.getProgress(g.draft.id)!.slots![0].attempts.length,2);await restarted.close();
});
test('a lost paid response reconciles a durable candidate after restart and resumes without a second generation for that slot',async t=>{
  const f=await fixture(t,{lostResponse:true}),bridge=currentListingBridge(f);
  bridge.project(context=>{for(const field of context.fields)field.description='Earlier field help';return context;});
  const first=await f.run();assert.equal(first.workflow.slots![0].status,'UNKNOWN');
  const attempt=first.workflow.slots![0].attempts[0],context=structuredClone(first.workflow.imageContext);
  bridge.project(value=>value);await f.service.close();const restarted=f.reopen();
  try{
    const result=await restarted.complete({draftId:f.draft.id,draftRevision:f.draft.revision});
    assert.equal(result.workflow.status,'COMPLETED',result.workflow.error??'');assert.equal(result.workflow.id,first.workflow.id);
    assert.equal(f.calls.filter(call=>call==='generate').length,7);assert.equal(result.workflow.slots![0].attempts.length,1);
    assert.equal(result.workflow.slots![0].attempts[0].requestId,attempt.requestId);assert.equal(result.workflow.slots![0].attempts[0].candidateId,attempt.requestId);
    assert.deepEqual(result.workflow.imageContext,context);assert.equal(result.workflow.contextSha256,first.workflow.contextSha256);
  }finally{await restarted.close();}
});
test('a paid 502 response checks recovery before a bounded retry after restart',async t=>{
  const f=await fixture(t);let posts=0,reconciliations=0;
  const adapter=new OpenAiImageAdapter({fetch:async()=>{posts++;return Response.json({error:{message:'gateway failed'}},{status:502});}});
  f.generation.generateForWorkflow=async()=>{await adapter.generate({apiKey:'local-fixture-key',model:'gpt-image-2.5-sunburst',prompt:'Source product',size:'1024x1024',quality:'high',background:'opaque',references:[]},new AbortController().signal);throw new Error('Unexpected generation success');};
  f.generation.reconcileWorkflowGeneration=async()=>{reconciliations++;return null;};
  const first=await f.run();assert.equal(first.workflow.slots![0].status,'UNKNOWN');assert.equal(posts,1);
  await f.service.close();const restarted=f.reopen();
  try{
    const resumed=await restarted.complete({draftId:f.draft.id,draftRevision:f.draft.revision});
    assert.equal(resumed.workflow.id,first.workflow.id);assert.equal(resumed.workflow.slots![0].attempts.length,2);
    assert.equal(reconciliations,1);assert.equal(posts,2);assert.equal(resumed.workflow.slots![0].status,'UNKNOWN');
  }finally{await restarted.close();}
});
test('a proven unsent generation failure preserves its ready attempt and resumes with the same request identity',async t=>{
  const f=await fixture(t),generate=f.generation.generateForWorkflow;let stop=true;
  f.generation.generateForWorkflow=async(...args)=>{if(stop){stop=false;throw Object.assign(new AiError('BUSY'),{notSent:true});}return generate(...args);};
  const first=await f.run(),attempt=first.workflow.slots![0].attempts[0];assert.equal(attempt.state,'READY');assert.equal(first.workflow.slots![0].status,'FAILED');assert.equal(f.calls.filter(call=>call==='generate').length,0);
  await f.service.close();const restarted=f.reopen();
  try{const resumed=await restarted.complete({draftId:f.draft.id,draftRevision:f.draft.revision});assert.equal(resumed.workflow.id,first.workflow.id);assert.equal(resumed.workflow.status,'COMPLETED');assert.equal(resumed.workflow.slots![0].attempts.length,1);assert.equal(resumed.workflow.slots![0].attempts[0].requestId,attempt.requestId);assert.equal(f.calls.filter(call=>call==='generate').length,7);}finally{await restarted.close();}
});
test('changed source and cancellation prevent late adoption',async t=>{
  const f=await fixture(t,{mutate:true}); assert.notEqual((await f.run()).workflow.status,'COMPLETED'); assert.equal(f.service.getProgress(f.draft.id)!.approvedAssetId,null);
  const g=await fixture(t,{hold:true}), pending=g.run(); await g.began; g.service.cancel(g.draft.id); g.release(); assert.equal((await pending).workflow.status,'CANCELLED');
});
test('same draft call is deduplicated while active, then restart marks unfinished work interrupted without sending',async t=>{
  const f=await fixture(t,{hold:true}), first=f.run(); await f.began; const second=f.run(); assert.equal(first,second); f.service.cancel(f.draft.id); f.release(); await first;
  await f.service.close(); const db=openDatabase(f.root);
  db.exec("UPDATE image_workflow_runs SET record_json=json_set(record_json,'$.status','RUNNING','$.error',NULL)"); db.close();
  const count=f.calls.length, restarted=f.reopen();
  assert.equal(restarted.getProgress(f.draft.id)!.status,'INTERRUPTED'); assert.equal(f.calls.length,count); await restarted.close();
});
test('blocked workflow is backed up durably, while a forged completion cannot enter a backup',async t=>{
  const f=await fixture(t,{configured:false}); const result=await f.run();
  const file=join(f.root,'safe.htcbackup'),target=join(f.root,'restored'); await createWorkspaceBackup(f.root,file,'local workflow backup passphrase');
  const prepared=await prepareWorkspaceRestore(target,file,'local workflow backup passphrase'); await commitWorkspaceRestore(target,prepared);
  const restored=openDatabase(target); try{assert.equal(JSON.parse(String(restored.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(result.workflow.id)!.record_json)).status,'BLOCKED');}finally{restored.close();}
  const db=openDatabase(f.root);db.exec("UPDATE image_workflow_runs SET record_json=json_set(record_json,'$.status','COMPLETED','$.stage','complete')");db.close();
  await assert.rejects(createWorkspaceBackup(f.root,join(f.root,'forged.htcbackup'),'local workflow backup passphrase'));
});
test('key-only rotation during planning blocks before the first paid image request',async t=>{
  const f=await fixture(t,{rotateKeyDuringPlan:true}), result=await f.run();
  assert.equal(result.workflow.status,'BLOCKED'); assert.equal(f.calls.includes('generate'),false); assert.match(result.workflow.error!,/配置/);
});
test('invalidated completed approval does not attempt to persist RUNNING with a complete stage',async t=>{
  const f=await fixture(t),first=await f.run(),db=openDatabase(f.root);
  try{db.prepare('UPDATE assets SET sha256=? WHERE id=?').run('a'.repeat(64),first.workflow.approvedAssetId!);}finally{db.close();}
  await assert.doesNotReject(f.run());
});
test('resuming interrupted copy recheck never generates pending images again',async t=>{
  const f=await fixture(t),first=await f.run();
  const changed=f.amazon.saveDraft({id:f.draft.id,revision:f.draft.revision,attributes:{...f.draft.attributes,item_name:[{value:'Updated title'}]}});
  const risk=f.ai.reviewGeneratedImageRisk;let calls=0;
  f.ai.reviewGeneratedImageRisk=async(...args)=>{if(++calls===2)throw new AiError('RATE_LIMITED');return risk(...args);};
  const partial=await f.service.recheck({draftId:changed.id,draftRevision:changed.revision,sourceWorkflowId:first.workflow.id});
  assert.equal(partial.workflow.slots![0].status,'PASSED');assert.equal(partial.workflow.status,'FAILED');
  const resumed=await f.service.recheck({draftId:changed.id,draftRevision:changed.revision,sourceWorkflowId:first.workflow.id});assert.equal(resumed.workflow.id,partial.workflow.id);assert.equal(resumed.workflow.status,'COMPLETED');assert.equal(calls,8);assert.equal(f.calls.filter(call=>call==='generate').length,7);
  assert.equal((await f.run()).workflow.id,resumed.workflow.id);
});
test('source preparation is deduplicated and cancellable, blocks paid overlap, and drains on close',async t=>{
  const f=await fixture(t),input={productId:f.product.id,productRevision:f.product.revision,variantIds:[f.product.variants[0].id]};
  const first=f.service.prepareSources(input);
  assert.equal(f.service.prepareSources(input),first);assert.equal(f.service.busy,true);
  assert.throws(()=>f.run(),/正在自动准备/);assert.deepEqual(f.service.cancelSources(f.product.id),{cancelled:true});
  await assert.rejects(first);assert.equal(f.service.busy,false);assert.deepEqual(f.calls,[]);
  const ready=await f.service.prepareSources(input);assert.deepEqual(ready.missing,[]);assert.equal(ready.product.revision,f.product.revision);
  const pending=f.service.prepareSources(input),closing=f.service.close();await assert.rejects(pending);await closing;
  assert.deepEqual(f.calls,[]);assert.throws(()=>f.service.prepareSources(input));
});


test('only the main image receives OCR and text review while every image receives IP review', async t => {
  const f=await fixture(t), result=await f.run();
  assert.equal(result.workflow.status,'COMPLETED',result.workflow.error??'');
  assert.equal(f.calls.filter(c=>c==='ip-check').length,7);
  assert.equal(f.calls.filter(c=>c==='ocr').length,1);
  assert.equal(f.calls.filter(c=>c==='review').length,1);
  assert.equal(result.workflow.slots![0].attempts[0].reviewResultId!==null,true);
  for(const slot of result.workflow.slots!.slice(1)){
    assert.equal(slot.attempts[0].ocrResultId,null);
    assert.equal(slot.attempts[0].reviewResultId,null);
    assert.equal((slot.attempts[0] as any).approvalPolicy,'ip-only-detail/v1');
  }
  await f.service.close();const restarted=f.reopen();
  try{assert.equal(restarted.getProgress(f.draft.id)?.status,'COMPLETED');}finally{await restarted.close();}
});


test('current copy failures repair within a durable two-round budget before any image generation',async t=>{
  const f=await fixture(t),original=f.listing.reviewCurrentForImages;
  f.listing.reviewCurrentForImages=async()=>{const value=await original();(value.review.output as any).verdict='NEEDS_CHANGES';return value;};
  let repairs=0;(f.listing as any).repairCurrentForImages=async()=>{repairs++;return {draft:f.amazon.getDraft(f.draft.id),aiCalls:1,remaining:['copy still unsupported'],blocked:false};};
  const first=await f.run();assert.equal(repairs,2);assert.equal(first.workflow.status,'BLOCKED');assert.equal(f.calls.includes('generate'),false);
  assert.equal((first.workflow as any).copyRepairAttempts,2);
  await f.service.close();const restarted=f.reopen();
  try{const count=f.calls.length;await restarted.complete({draftId:f.draft.id,draftRevision:f.draft.revision});assert.equal(repairs,2);assert.equal(f.calls.length,count);}finally{await restarted.close();}
});
test('planned missing main URL does not prevent generating its images',async t=>{
  const f=await fixture(t);
  const issue={code:'LOCAL_required',message:'main_product_image_locator：缺少必填字段',severity:'ERROR' as const,attributeNames:['main_product_image_locator'],category:'image' as const,source:'local' as const,autoFixable:false};
  f.listing.complete=async()=>({draft:{...f.draft,localIssues:[issue]},aiCalls:0,previewAttempts:0,remaining:[`main_product_image_locator：${issue.message}`]});
  const result=await f.run();assert.equal(result.workflow.status,'COMPLETED',result.workflow.error??'');assert.equal(f.calls.filter(call=>call==='generate').length,7);
});

test('remaining required fields stop before paying for image planning or generation',async t=>{
  const f=await fixture(t);f.listing.complete=async()=>({draft:f.draft,aiCalls:0,previewAttempts:0,remaining:['color missing']});
  const result=await f.run();assert.equal(result.workflow.status,'BLOCKED');assert.match(result.workflow.error!,/color missing/);assert.equal(f.calls.includes('generate'),false);assert.equal(f.calls.includes('content-review'),false);
});

test('source colors are prepared before content and counted before any paid image planning',async t=>{
  const f=await fixture(t);
  (f.listing as any).prepareSourceColors=async()=>{f.calls.push('source-colors');return {aiCalls:1,evidenceChanged:true};};
  const result=await f.run();
  assert.deepEqual(f.calls.slice(0,3),['source-colors','content','content-review']);
  assert.equal(result.workflow.status,'COMPLETED',result.workflow.error??'');
  assert.equal(result.aiCalls,22);
});

test('uncertain source colors stop before content, planning or generation',async t=>{
  const f=await fixture(t);
  (f.listing as any).prepareSourceColors=async()=>{f.calls.push('source-colors');throw new AiError('OUTPUT_INVALID');};
  const result=await f.run();
  assert.deepEqual(f.calls,['source-colors']);assert.equal(result.workflow.status,'FAILED');
  assert.equal(result.workflow.slots!.every(slot=>!slot.attempts.length),true);
});

test('resuming an existing image context prepares source colors and preserves interrupted phase and attempts',async t=>{
  const f=await fixture(t,{generationError:true}),first=await f.run();
  assert.ok(first.workflow.imageContext);assert.equal(first.workflow.stage,'generating');
  (f.listing as any).prepareSourceColors=async()=>{f.calls.push('source-colors');f.service.cancel(f.draft.id);throw new AiError('CANCELLED');};
  const count=f.calls.length,next=await f.run();
  assert.deepEqual(f.calls.slice(count),['source-colors']);assert.equal(next.workflow.status,'CANCELLED');
  assert.equal(next.workflow.stage,first.workflow.stage);assert.equal(next.workflow.id,first.workflow.id);
  assert.deepEqual(next.workflow.slots,first.workflow.slots);assert.deepEqual(next.workflow.imageContext,first.workflow.imageContext);
});

function sourceColorBridge(f:Awaited<ReturnType<typeof fixture>>){
  const resultId=randomUUID(),source=f.store.getAssetRecord(f.product.assets[0].id)!;
  const evidence:ListingEvidence={id:`${f.draft.variantId}:source-color:${resultId}`,name:'Verified selected source-image color',value:'Silver',meaning:'color',source:'source_image',
    imageObservation:{resultId,colors:['Silver'],context:{policyVersion:'source-color/v1',productId:f.product.id,productRevision:f.product.revision,variantId:f.draft.variantId,
      sourceSpec:f.product.variants[0].sourceSpec,referenceAssets:[{assetId:source.id,sha256:source.sha256}]}}};
  const evidenceSha256=listingFingerprint([evidence]);
  const currentContext=(draft:AmazonDraft,product:typeof f.product,generation:number)=>{
    const context=buildListingContext(draft,product,generation);
    context.evidence.push(structuredClone(evidence));
    return context;
  };
  Object.assign(f.listing,{currentContext,prepareSourceColors:async()=>({aiCalls:0,evidenceChanged:false,evidenceSha256})});
  const previous=f.listing.snapshotCurrentForImages;
  f.listing.snapshotCurrentForImages=async()=>({...await previous(),context:currentContext(f.amazon.getDraft(f.draft.id),f.store.getProduct(f.product.id),f.amazon.executionTargetScope(f.draft.targetId).generation)});
  return {currentContext,evidenceSha256};
}

test('a new source-color fingerprint grants one content repair and stays consumed across restart',async t=>{
  const f=await fixture(t);f.service.saveCopyReviewSettings({enabled:false});let repairs=0;
  f.listing.complete=async()=>{repairs++;return {draft:f.amazon.getDraft(f.draft.id),aiCalls:1,previewAttempts:0,remaining:['color missing']};};
  const first=await f.run();assert.equal(first.workflow.status,'BLOCKED');assert.equal(repairs,1);
  const bridge=sourceColorBridge(f);
  const second=await f.run();assert.equal(second.workflow.status,'BLOCKED');assert.equal(repairs,2);
  assert.equal(second.workflow.contentPreparation?.sourceColorEvidenceSha256,bridge.evidenceSha256);
  await f.service.close();const restored=f.reopen();
  try{const third=await restored.complete({draftId:f.draft.id,draftRevision:f.draft.revision});assert.equal(third.workflow.id,first.workflow.id);assert.equal(repairs,2);assert.equal(third.workflow.contentPreparation?.state,'DONE');}
  finally{await restored.close();}
  assert.equal(f.calls.includes('generate'),false);
});

test('a changed observation without verified source-color evidence cannot reopen paid field repair',async t=>{
  const f=await fixture(t);let repairs=0;
  f.listing.complete=async()=>{repairs++;return {draft:f.draft,aiCalls:1,previewAttempts:0,remaining:['color missing']};};
  const first=await f.run();assert.equal(repairs,1);
  (f.listing as any).prepareSourceColors=async()=>({aiCalls:0,evidenceChanged:true});
  const second=await f.run();assert.equal(second.workflow.id,first.workflow.id);assert.equal(second.workflow.status,'BLOCKED');assert.equal(repairs,1);assert.equal(f.calls.includes('generate'),false);
});

test('an interrupted source-color field repair reserves its fingerprint before the request and never repeats',async t=>{
  const f=await fixture(t);f.service.saveCopyReviewSettings({enabled:false});
  f.listing.complete=async()=>({draft:f.draft,aiCalls:0,previewAttempts:0,remaining:['color missing']});await f.run();const bridge=sourceColorBridge(f);
  let requests=0;
  f.listing.complete=async()=>{requests++;assert.equal(f.service.getProgress(f.draft.id)?.contentPreparation?.sourceColorEvidenceSha256,bridge.evidenceSha256);f.service.cancel(f.draft.id);throw new AiError('CANCELLED');};
  const interrupted=await f.run();assert.equal(requests,1);assert.equal(interrupted.workflow.status,'CANCELLED');assert.equal(interrupted.workflow.contentPreparation?.state,'STARTED');
  let repeatedColorPreparations=0;
  (f.listing as any).prepareSourceColors=async()=>{repeatedColorPreparations++;return {aiCalls:0,evidenceChanged:false,evidenceSha256:bridge.evidenceSha256};};
  await f.service.close();const restored=f.reopen();
  try{const stopped=await restored.complete({draftId:f.draft.id,draftRevision:f.draft.revision});assert.equal(requests,1);assert.equal(stopped.workflow.contentPreparation?.state,'STARTED');assert.match(stopped.workflow.error??'',/尚未确认/);}
  finally{await restored.close();}
  assert.equal(repeatedColorPreparations,0,'Unknown field result must stop before any new paid source observation');
});

test('completed seven images use new source-color evidence to repair fields and recheck without new generation',async t=>{
  const f=await fixture(t);f.service.saveCopyReviewSettings({enabled:false});f.service.saveRiskSettings({enabled:false});
  const first=await f.run();assert.equal(first.workflow.status,'COMPLETED',first.workflow.error??'');
  const db=openDatabase(f.root),saved=String(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(first.workflow.id)!.record_json);
  try{
    const raw=JSON.parse(String(db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(f.draft.id)!.record_json));
    raw.draft.localIssues=[{code:'LOCAL_required',message:'color missing',severity:'ERROR',attributeNames:['color'],category:'field',source:'local',autoFixable:false}];
    db.prepare('UPDATE listing_drafts SET record_json=? WHERE id=?').run(JSON.stringify(raw),f.draft.id);
    sourceColorBridge(f);let repairs=0;
    f.listing.complete=async()=>{repairs++;const draft=f.amazon.getDraft(f.draft.id);return {draft:f.amazon.saveDraft({id:draft.id,revision:draft.revision,attributes:{...draft.attributes,color:[{value:'Silver',marketplace_id:draft.marketplaceId}]}}),aiCalls:1,previewAttempts:0,remaining:[]};};
    const count=f.calls.length,next=await f.run();
    assert.equal(next.workflow.status,'COMPLETED',next.workflow.error??'');assert.equal(next.workflow.recheckedFromRunId,first.workflow.id);assert.equal(repairs,1);
    assert.equal(f.calls.slice(count).includes('generate'),false);assert.equal(f.calls.slice(count).includes('ocr'),true);
    assert.equal(next.workflow.riskInterceptionEnabled,false);assert.equal(next.workflow.copyReviewEnabled,false);
    assert.deepEqual(next.workflow.slots!.map(slot=>[slot.approvedAssetId,slot.attempts.at(-1)!.candidateId]),first.workflow.slots!.map(slot=>[slot.approvedAssetId,slot.attempts.at(-1)!.candidateId]));
    assert.equal(String(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(first.workflow.id)!.record_json),saved);
    assert.equal((await f.run()).workflow.id,next.workflow.id);assert.equal(repairs,1);
  }finally{db.close();}
});

test('new source-color evidence cannot rewrite an incomplete immutable context or resend unknown generation',async t=>{
  const f=await fixture(t,{generationError:true}),first=await f.run();assert.equal(first.workflow.slots![0].attempts[0].state,'UNKNOWN');sourceColorBridge(f);
  const count=f.calls.length,next=await f.run();
  assert.equal(next.workflow.status,'BLOCKED');assert.equal(next.workflow.id,first.workflow.id);assert.equal(f.calls.length,count);
  assert.deepEqual(next.workflow.imageContext,first.workflow.imageContext);assert.deepEqual(next.workflow.slots,first.workflow.slots);
});

test('an incomplete color repair of seven saved images stays blocked across restart without another paid repair',async t=>{
  const f=await fixture(t);f.service.saveCopyReviewSettings({enabled:false});const first=await f.run();assert.equal(first.workflow.status,'COMPLETED');
  const db=openDatabase(f.root);
  try{const raw=JSON.parse(String(db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(f.draft.id)!.record_json));
    raw.draft.localIssues=[{code:'LOCAL_required',message:'color missing',severity:'ERROR',attributeNames:['color'],category:'field',source:'local',autoFixable:false}];
    db.prepare('UPDATE listing_drafts SET record_json=? WHERE id=?').run(JSON.stringify(raw),f.draft.id);
  }finally{db.close();}
  sourceColorBridge(f);let repairs=0;
  f.listing.complete=async()=>{repairs++;return {draft:f.amazon.getDraft(f.draft.id),aiCalls:1,previewAttempts:0,remaining:['color still missing']};};
  const count=f.calls.length,blocked=await f.run();assert.equal(blocked.workflow.status,'BLOCKED');assert.equal(blocked.workflow.recheckedFromRunId,first.workflow.id);assert.equal(repairs,1);
  await f.service.close();const restored=f.reopen();
  try{const next=await restored.recheck({draftId:f.draft.id,draftRevision:f.draft.revision,sourceWorkflowId:first.workflow.id});
    assert.equal(next.workflow.id,blocked.workflow.id);assert.equal(next.workflow.status,'BLOCKED');assert.equal(next.workflow.contentPreparation?.state,'DONE');assert.equal(repairs,1);
    assert.match(next.workflow.error??'',/color still missing/);assert.equal(f.calls.length,count);
  }finally{await restored.close();}
});

test('a completed source-color repair cancelled before its snapshot proves the new draft and resumes the original seven images',async t=>{
  const f=await fixture(t);f.service.saveCopyReviewSettings({enabled:false});const first=await f.run();
  const db=openDatabase(f.root);
  try{const raw=JSON.parse(String(db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(f.draft.id)!.record_json));
    raw.draft.localIssues=[{code:'LOCAL_required',message:'color missing',severity:'ERROR',attributeNames:['color'],category:'field',source:'local',autoFixable:false}];
    db.prepare('UPDATE listing_drafts SET record_json=? WHERE id=?').run(JSON.stringify(raw),f.draft.id);
  }finally{db.close();}
  sourceColorBridge(f);let repairs=0;
  f.listing.complete=async()=>{repairs++;const draft=f.amazon.getDraft(f.draft.id);return {draft:f.amazon.saveDraft({id:draft.id,revision:draft.revision,attributes:{...draft.attributes,color:[{value:'Silver',marketplace_id:draft.marketplaceId}]}}),aiCalls:1,previewAttempts:0,remaining:[]};};
  const snapshot=f.listing.snapshotCurrentForImages;
  f.listing.snapshotCurrentForImages=async()=>{f.service.cancel(f.draft.id);throw new AiError('CANCELLED');};
  const count=f.calls.length,stopped=await f.run();assert.equal(stopped.workflow.status,'CANCELLED');assert.equal(stopped.workflow.stage,'content');assert.equal(stopped.workflow.imageContext,undefined);
  assert.equal(stopped.workflow.contentPreparation?.state,'DONE');assert.equal(stopped.workflow.contentPreparation?.draftSha256,imageWorkflowDraftStamp(stopped.draft));
  const input={draftId:f.draft.id,draftRevision:stopped.draft.revision,sourceWorkflowId:first.workflow.id};
  assert.equal(f.service.canResumeRecheckDraft(input),true);
  f.listing.snapshotCurrentForImages=snapshot;await f.service.close();const restored=f.reopen();
  try{assert.equal(restored.canResumeRecheckDraft(input),true);const next=await restored.recheck(input);
    assert.equal(next.workflow.status,'COMPLETED',next.workflow.error??'');assert.equal(next.workflow.id,stopped.workflow.id);assert.equal(repairs,1);
    assert.equal(f.calls.slice(count).includes('generate'),false);assert.deepEqual(next.workflow.slots!.map(slot=>slot.approvedAssetId),first.workflow.slots!.map(slot=>slot.approvedAssetId));
  }finally{await restored.close();}
});

test('an exhausted legacy detail text rejection reuses its IP-approved candidate with no new text checks',async t=>{
  const f=await fixture(t,{rejectSlot:5}),risk=f.ai.reviewGeneratedImageRisk;
  f.ai.reviewGeneratedImageRisk=async(...args)=>{const result=await risk(...args);if((args[0] as ProductImageContext).slot?.index===5)f.service.cancel(f.draft.id);return result;};
  const first=await f.service.complete({draftId:f.draft.id,draftRevision:f.draft.revision},{maxImageAttempts:1});
  assert.equal(first.workflow.status,'CANCELLED');
  const run=structuredClone(first.workflow),slot=run.slots![4],attempt=slot.attempts[0];
  const ip=f.ai.getResult(attempt.ipReviewResultId!);if(ip.output.kind!=='image-ip-review')throw Error('IP missing');
  const context={...run.imageContext!,setPlan:run.setPlan,purpose:'detail' as const,slot:{index:5,total:7 as const,provisional:true as const}};
  const ocr=await f.ai.recognizeGeneratedImage(context,ip.output.candidate),review=await f.ai.reviewGeneratedImage(context,f.ai.getResult(attempt.planResultId!),ocr,ip.output.candidate);
  attempt.ocrResultId=ocr.id;attempt.reviewResultId=review.id;attempt.state='RETRYABLE_FAILURE';attempt.error='legacy false OCR character';slot.status='FAILED';slot.error=attempt.error;
  run.status='BLOCKED';run.error=attempt.error;run.ocrResultIds.push(ocr.id);run.reviewResultIds.push(review.id);
  await f.service.close();const db=openDatabase(f.root);try{db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(JSON.stringify(run),run.id);}finally{db.close();}
  f.ai.reviewGeneratedImageRisk=risk;const restarted=f.reopen();
  try{const before=f.calls.length;assert.equal(canResumeImageWorkflow(restarted.getProgress(f.draft.id)),true);
    const result=await restarted.complete({draftId:f.draft.id,draftRevision:f.draft.revision});assert.equal(result.workflow.status,'COMPLETED',result.workflow.error??'');
    assert.equal(result.workflow.slots![4].attempts.length,1);assert.equal(result.workflow.slots![4].attempts[0].candidateId,attempt.candidateId);assert.equal(result.workflow.slots![4].attempts[0].reviewResultId,review.id);
    assert.equal(f.calls.slice(before).includes('ocr'),false);assert.equal(f.calls.slice(before).includes('review'),false);assert.equal(f.calls.slice(before).filter(c=>c==='generate').length,2);
  }finally{await restarted.close();}
});


test('a saved successful second copy repair survives a later source OCR failure without paying for copy again',async t=>{
  const f=await fixture(t),original=f.listing.reviewCurrentForImages;
  f.listing.reviewCurrentForImages=async()=>{const value=await original();value.review.listingContext=value.context;(value.review.output as any).currentListingCopy=value.currentListingCopy;(value.review.output as any).verdict='NEEDS_CHANGES';return value;};
  let repairs=0;(f.listing as any).repairCurrentForImages=async()=>{repairs++;if(repairs===1)return {draft:f.draft,aiCalls:1,remaining:['still needs repair'],blocked:false};const review=await f.listing.reviewCurrentForImages();(review.review.output as any).verdict='PASS';return {draft:f.draft,aiCalls:1,remaining:[],review,blocked:false};};
  const recognize=f.ai.recognize;f.ai.recognize=async()=>{throw new AiError('NETWORK_ERROR');};
  const first=await f.run();assert.equal(first.workflow.status,'FAILED');assert.equal(first.workflow.copyRepairAttempts,2);assert.ok(first.workflow.copyReviewResultId);
  f.ai.recognize=recognize;await f.service.close();const restarted=f.reopen();
  try{const count=f.calls.length;const result=await restarted.complete({draftId:f.draft.id,draftRevision:f.draft.revision});assert.equal(result.workflow.status,'COMPLETED',result.workflow.error??'');assert.equal(repairs,2);assert.equal(f.calls.slice(count).includes('content-review'),false);assert.equal(f.calls.slice(count).includes('content'),false);}finally{await restarted.close();}
});
test('concurrent approval of the same unknown request records authorization only once',async t=>{
  const f=await fixture(t,{generationError:true}),first=await f.run(),requestId=first.workflow.slots![0].attempts[0].requestId;
  const input={draftId:f.draft.id,slot:1,requestId},before=f.calls.length;
  const outcomes=await Promise.allSettled([f.service.approveUnknownRetry(input),f.service.approveUnknownRetry(input)]);
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(f.calls.length,before);assert.equal(f.service.getProgress(f.draft.id)!.slots![0].attempts.length,1);
  const db=openDatabase(f.root);try{assert.equal(db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='image.workflow.unknown-retry-authorized'").get()?.n,1);}finally{db.close();}
});
test('unknown retry at the attempt limit preserves the unresolved record without a paid request',async t=>{
  const f=await fixture(t,{generationError:true});
  const first=await f.service.complete({draftId:f.draft.id,draftRevision:f.draft.revision},{maxImageAttempts:1});
  const before=f.calls.length,progress=f.service.getProgress(f.draft.id);
  await assert.rejects(()=>f.service.approveUnknownRetry({draftId:f.draft.id,slot:1,requestId:first.workflow.slots![0].attempts[0].requestId}),/用完尝试次数/);
  assert.equal(f.calls.length,before);assert.deepEqual(f.service.getProgress(f.draft.id),progress);
});
test('known incomplete field preparation is retained across restart without repeating paid completion',async t=>{
  const f=await fixture(t);let count=0;f.listing.complete=async()=>{count++;return {draft:f.draft,aiCalls:2,previewAttempts:1,remaining:['color missing']};};
  await f.run();await f.service.close();const restarted=f.reopen();
  try{const result=await restarted.complete({draftId:f.draft.id,draftRevision:f.draft.revision});assert.equal(result.workflow.status,'BLOCKED');assert.equal(count,1);assert.match(result.workflow.error!,/color missing/);}finally{await restarted.close();}
});


import { resolveConsistencyContext, consistencyDecisionKey } from '../src/main/source-image-consistency/scope.ts';
import { saveConsistencyDecision } from '../src/main/source-image-consistency/proof.ts';
test('QUALITY: human correction during final generation freshness await prevents send',async t=>{
  const f=await fixture(t),db=openDatabase(f.root);let armed=false,sends=0,corrected=false;
  const getSchema=f.amazon.getSchema.bind(f.amazon),generate=f.generation.generateForWorkflow;
  f.amazon.getSchema=async input=>{
    const schema=await getSchema(input);
    if(armed&&!corrected){
      corrected=true;const product=f.store.getProduct(f.product.id),context=resolveConsistencyContext(db,f.store,f.root,{productId:product.id,productRevision:product.revision,variantId:product.variants[0].id});
      const view=await saveConsistencyDecision(db,f.store,f.root,{productId:product.id,productRevision:product.revision,variantId:product.variants[0].id,fingerprint:consistencyDecisionKey(context),decision:'CORRECTION_NEEDED',reason:'Synthetic user discovers wrong original while presend schema awaits'});
      assert.equal(view.status,'NEEDS_INPUT');
    }
    return schema;
  };
  (f.generation as any).generateForWorkflow=async(input:any,attempt:any,signal:any,assertFresh?:()=>Promise<void>)=>{
    armed=true;await assertFresh?.();sends++;return generate(input,attempt,signal);
  };
  try{const result=await f.run();assert.equal(result.workflow.status,'BLOCKED');assert.ok(corrected);assert.equal(sends,0,'final presend freshness must reject changed human proof');}finally{db.close();}
});

test('QUALITY: source OCR final callback prevents send after human correction',async t=>{
  const f=await fixture(t),db=openDatabase(f.root);let sends=0,corrected=false;const recognize=f.ai.recognize;
  (f.ai as any).recognize=async(_input:any,_signal:any,beforeSend?:()=>void)=>{
    const product=f.store.getProduct(f.product.id),context=resolveConsistencyContext(db,f.store,f.root,{productId:product.id,productRevision:product.revision,variantId:product.variants[0].id});
    const view=await saveConsistencyDecision(db,f.store,f.root,{productId:product.id,productRevision:product.revision,variantId:product.variants[0].id,fingerprint:consistencyDecisionKey(context),decision:'CORRECTION_NEEDED',reason:'Synthetic correction while OCR prepares source bytes'});
    corrected=view.status==='NEEDS_INPUT';beforeSend?.();sends++;return recognize();
  };
  try{const result=await f.run();assert.equal(result.workflow.status,'BLOCKED');assert.ok(corrected);assert.equal(sends,0,'workflow OCR presend callback must reject changed proof');}finally{db.close();}
});


test('QUALITY: legacy freshness accepts current proof and blocks correction during its final schema await',async t=>{
  for(const correct of [false,true])await t.test(correct?'revoked':'current',async t=>{
    const f=await fixture(t,{rejectSlot:-1}),db=openDatabase(f.root);let armed=false,changed=false,sends=0;
    const getSchema=f.amazon.getSchema.bind(f.amazon),generate=f.generation.generate;
    (f.service as any).runSeven=(run:any,initial:any,signal:AbortSignal)=>{
      const names=['id','draftId','productId','productRevision','variantId','sku','status','stage','attempt','maxAttempts','contextSha256','draftSha256','referenceAssets','planResultIds','candidateIds','ocrResultIds','reviewResultIds','ipReviewResultIds','approvedAssetId','approvedSha256','createdAt','updatedAt','error','imagePolicyVersion'];
      return (f.service as any).run({...Object.fromEntries(names.map(name=>[name,run[name]])),maxAttempts:2},initial,signal);
    };
    f.amazon.getSchema=async input=>{
      const schema=await getSchema(input);
      if(correct&&armed&&!changed){changed=true;const p=f.store.getProduct(f.product.id),context=resolveConsistencyContext(db,f.store,f.root,{productId:p.id,productRevision:p.revision,variantId:p.variants[0].id});await saveConsistencyDecision(db,f.store,f.root,{productId:p.id,productRevision:p.revision,variantId:p.variants[0].id,fingerprint:consistencyDecisionKey(context),decision:'CORRECTION_NEEDED',reason:'Synthetic correction during legacy final freshness await'});}
      return schema;
    };
    (f.generation as any).generate=async(input:any,signal:any,fresh:()=>Promise<void>)=>{armed=true;await fresh();sends++;return generate(input,signal);};
    try{const result=await f.run();assert.equal(sends,correct?0:1);assert.equal(result.workflow.status,correct?'BLOCKED':'COMPLETED',result.workflow.error??'');assert.equal(changed,correct);}finally{db.close();}
  });
});

test('QUALITY: correction during final adoption freshness retains paid candidate without approval',async t=>{
  const f=await fixture(t),db=openDatabase(f.root),getSchema=f.amazon.getSchema.bind(f.amazon);let changed=false,adoptionChecks=0;
  f.amazon.getSchema=async input=>{
    const schema=await getSchema(input);
    if(!changed&&JSON.parse(String(db.prepare('SELECT record_json FROM image_workflow_runs ORDER BY rowid DESC LIMIT 1').get()?.record_json??'{}')).stage==='adopting'&&++adoptionChecks===2){
      changed=true;const p=f.store.getProduct(f.product.id),context=resolveConsistencyContext(db,f.store,f.root,{productId:p.id,productRevision:p.revision,variantId:p.variants[0].id});await saveConsistencyDecision(db,f.store,f.root,{productId:p.id,productRevision:p.revision,variantId:p.variants[0].id,fingerprint:consistencyDecisionKey(context),decision:'CORRECTION_NEEDED',reason:'Synthetic correction during adoption freshness await'});
    }
    return schema;
  };
  try{const result=await f.run();assert.ok(changed);assert.equal(result.workflow.status,'BLOCKED');assert.equal(f.calls.filter(c=>c==='generate').length,1);assert.equal(result.workflow.candidateIds.length,1);assert.ok(await f.generation.readCandidate(result.workflow.candidateIds[0]));assert.equal(result.workflow.approvedAssetId,null);assert.equal(result.workflow.slots!.some(s=>s.status==='PASSED'),false);}finally{db.close();}
});

test('legacy partial paid slots continue after full-schema policy upgrade and restart without changing frozen hashes or requests',async t=>{
  const f=await fixture(t);f.service.saveCopyReviewSettings({enabled:false});
  const current=(draft:AmazonDraft,product:typeof f.product,generation:number)=>buildListingContext(draft,product,generation,true);
  (f.listing as any).currentContext=current;
  (f.listing as any).snapshotCurrentForImages=async()=>{const d=f.amazon.getDraft(f.draft.id),context=current(d,f.store.getProduct(f.product.id),f.amazon.executionTargetScope(d.targetId).generation);return currentImageListingSnapshot(d,context);};
  const plan=f.ai.imagePlan;let interrupted=false;
  f.ai.imagePlan=async context=>{if(context.slot?.index===3&&!interrupted){interrupted=true;throw new AiError('PROVIDER_ERROR');}return plan(context);};
  const first=await f.run();assert.equal(first.workflow.slots?.filter(s=>s.status==='PASSED').length,2);
  const frozen=structuredClone(first.workflow.imageContext),slots=structuredClone(first.workflow.slots!.slice(0,2)),request=first.workflow.slots![2].attempts[0].requestId;
  await f.service.close();
  (f.listing as any).currentContext=(draft:AmazonDraft,product:typeof f.product,generation:number)=>buildListingContext(draft,product,generation);
  const resumed=f.reopen();
  try{const result=await resumed.complete({draftId:f.draft.id,draftRevision:f.amazon.getDraft(f.draft.id).revision});
    assert.equal(result.workflow.status,'COMPLETED',result.workflow.error??'');assert.equal(result.workflow.id,first.workflow.id);
    assert.deepEqual(result.workflow.imageContext,frozen);assert.deepEqual(result.workflow.slots!.slice(0,2),slots);assert.equal(result.workflow.slots![2].attempts[0].requestId,request);
    assert.equal(f.calls.filter(call=>call==='generate').length,7);assert.ok(result.workflow.policyReevaluation);
  }finally{await resumed.close();}
});


test('new permissive legacy set plan survives persisted workflow reload with image v5',async t=>{
  const f=await fixture(t);f.service.saveCopyReviewSettings({enabled:false});
  const current=(draft:AmazonDraft,product:typeof f.product,generation:number)=>buildListingContext(draft,product,generation,true);
  (f.listing as any).currentContext=current;
  (f.listing as any).snapshotCurrentForImages=async()=>{const d=f.amazon.getDraft(f.draft.id);return currentImageListingSnapshot(d,current(d,f.store.getProduct(f.product.id),f.amazon.executionTargetScope(d.targetId).generation));};
  const plan=f.ai.imagePlan;
  f.ai.imagePlan=async context=>{if(context.slot)throw new AiError('PROVIDER_ERROR');const result=await plan(context);const set=(result.output as {setPlan:ReturnType<typeof sceneSet>}).setPlan;if(!set)return result;set.slots[1].textMode='planned';set.slots[1].expectedText=[{text:'An inviting everyday accent',evidenceIds:[]}];return result;};
  const first=await f.run();assert.equal(first.workflow.listingEvidenceContractVersion,'listing-evidence/v5');assert.deepEqual(first.workflow.setPlan?.slots[1].expectedText,[{text:'An inviting everyday accent',evidenceIds:[]}],first.workflow.error??'');
  await f.service.close();const db=openDatabase(f.root);
  try{const {workflowRuns}=await import('../src/main/image-workflow/records.ts');const restored=workflowRuns(db,f.draft.id).find(r=>r.id===first.workflow.id)!;assert.ok(restored);assert.deepEqual(restored.setPlan,first.workflow.setPlan);assert.deepEqual(restored.imageContext,first.workflow.imageContext);}finally{db.close();}
});

test('historical references preserve existing manual source authority for an eligible unbound original',async t=>{
 const f=await fixture(t),db=openDatabase(f.root);try{
 const product=f.store.getProduct(f.product.id),asset=product.assets[0],at=new Date().toISOString();
 const run={id:randomUUID(),draftId:f.draft.id,productId:product.id,productRevision:product.revision,variantId:product.variants[0].id,sku:product.variants[0].sku,status:'BLOCKED',stage:'planning',attempt:0,maxAttempts:2,contextSha256:null,draftSha256:null,referenceAssets:[{id:asset.id,sha256:f.store.getAssetRecord(asset.id)!.sha256}],planResultIds:[],candidateIds:[],ocrResultIds:[],reviewResultIds:[],approvedAssetId:null,approvedSha256:null,createdAt:at,updatedAt:at,error:'historical interruption'};
 db.prepare('INSERT INTO image_workflow_runs VALUES(?,?)').run(run.id,JSON.stringify(run));
 f.store.getProduct(product.id);
 assert.equal(db.prepare('SELECT count(*) n FROM variant_assets WHERE asset_id=?').get(asset.id)?.n,0);
 assert.doesNotThrow(()=>f.store.assertSourceConsistency(product.id,[product.variants[0].id]));
 }finally{db.close();}
});

test('completed seven-image execution preserves approval after plain color migration without regeneration',async t=>{
 const f=await fixture(t),market=f.draft.marketplaceId;
 f.amazon.saveDraft({id:f.draft.id,revision:f.draft.revision,attributes:{...f.draft.attributes,brand:[{value:'Verified Brand',marketplace_id:market}],color:[{value:'Cherry Blossom Pink',marketplace_id:market}],purchasable_offer:[{marketplace_id:market,currency:'USD',audience:'ALL',our_price:[{schedule:[{value_with_tax:12.5}]}]}]}});
 const completed=await f.run();assert.equal(completed.workflow.status,'COMPLETED',completed.workflow.error??'');const calls=[...f.calls];
 const {plainColorApprovalMatches}=await import('../src/main/image-workflow/approval-reuse.ts');
 const current=f.amazon.getDraft(f.draft.id),renamed={...current,attributes:{...current.attributes,color:[{value:'Pink',marketplace_id:market}]}};
 assert.equal(plainColorApprovalMatches(completed.workflow,renamed,f.store.getProduct(f.product.id)),true);
 for(const [field,value] of [['material','Steel'],['number_of_items',12]] as const)assert.equal(plainColorApprovalMatches(completed.workflow,{...renamed,attributes:{...renamed.attributes,[field]:[{value}]}},f.store.getProduct(f.product.id)),false);
 const changedSource=structuredClone(f.store.getProduct(f.product.id));changedSource.variants[0].originalSpec='Blue';assert.equal(plainColorApprovalMatches(completed.workflow,renamed,changedSource),false);
 assert.equal(plainColorApprovalMatches(completed.workflow,{...renamed,mode:'live'},f.store.getProduct(f.product.id)),false);
 const {ExecutionService}=await import('../src/main/execution/service.ts'),uploads=new Map<string,any>();let uploadCalls=0;
 const hosting={getProfile:()=>({id:'alpha',name:'Alpha',host:'ftp.example.test',port:21,secure:true,remoteRoot:'/',publicBaseUrl:'https://images.example.test/',enabled:true,configured:true,generation:1}),upload:async({assetId}:{assetId:string})=>{uploadCalls++;const value={id:randomUUID(),assetId,profileId:'alpha',generation:1,sha256:f.store.getAssetRecord(assetId)!.sha256,publicUrl:`https://images.example.test/${assetId}.png`,status:'AVAILABLE'};uploads.set(value.id,value);return value;},verify:async(id:string)=>uploads.get(id)};
 const execution=new ExecutionService(f.root,f.store,f.amazon,hosting),db=openDatabase(f.root);
 try{
  const raw=String(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(completed.workflow.id)!.record_json),task=execution.create({draftIds:[f.draft.id],profileId:'alpha'});
  execution.startAuthorized(execution.prepareStart(task.id));await execution.waitForIdle();const done=execution.get(task.id);
  assert.equal(done.status,'COMPLETED',done.error??'');assert.equal(uploadCalls,7);assert.deepEqual(f.calls,calls);assert.equal(String(db.prepare('SELECT record_json FROM image_workflow_runs WHERE id=?').get(completed.workflow.id)!.record_json),raw);
  assert.deepEqual(done.items[0].assets.map(a=>a.id),completed.workflow.slots!.map(s=>s.approvedAssetId));
 }finally{db.close();await execution.close();}
});
