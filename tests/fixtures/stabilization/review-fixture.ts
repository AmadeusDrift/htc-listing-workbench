// Synthetic workflow infrastructure copied from the baseline image-workflow tests.
import { confirmSourceConsistencyFixture } from '../../helpers/source-consistency-proof.ts';
import { sceneSet } from '../image-set.ts';
import type test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { WorkspaceStore } from '../../../src/main/store.ts';
import { AmazonService } from '../../../src/main/amazon/service.ts';
import { SkuNamingService } from '../../../src/main/sku-naming/service.ts';
import { buildSalesRecipes } from '../../../src/main/sales-plans/recipes.ts';
import { salesStoreScope } from '../../../src/main/sales-plans/planning.ts';
import { defaultListingRules } from '../../../src/shared/listing-rules.ts';
import type { AmazonDraft } from '../../../src/shared/amazon-contracts.ts';
import type { SalesListingPlan } from '../../../src/shared/sales-plan-contracts.ts';
import { importImageFiles } from '../../../src/main/assets.ts';
import { buildListingContext } from '../../../src/main/listing-ai/context.ts';
import { ImageWorkflowService } from '../../../src/main/image-workflow/service.ts';
import { openDatabase } from '../../../src/main/database.ts';
import { AiError } from '../../../src/main/ai/errors.ts';
import type { AiResult } from '../../../src/shared/ai-contracts.ts';
import type { GeneratedImageCandidate } from '../../../src/shared/image-generation-contracts.ts';
import type { ProductImageContext } from '../../../src/shared/image-ai-contracts.ts';
import type { ListingAiContext } from '../../../src/shared/listing-ai-contracts.ts';
import { listingFingerprint } from '../../../src/main/listing-ai/validation.ts';
const png = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(13,8); png.write('IHDR',12); png.writeUInt32BE(256,16); png.writeUInt32BE(256,20);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function copyReview(context:ListingAiContext,copy:{field:any;values:string[]}[]){
  return {kind:'listing-current-review' as const,verdict:'PASS' as const,currentListingCopy:copy,copySha256:listingFingerprint(copy),issues:[],checks:copy.flatMap(item=>item.values.map((value,index)=>{
    const evidenceIds=context.evidence.filter(e=>['material','color','item_shape','care_instructions'].includes(item.field)?e.meaning===item.field:true).map(e=>e.id);
    return {field:item.field,index,verdict:'SUPPORTED' as const,evidenceIds,reason:'Fixture source.',claims:[{text:value,verdict:'SUPPORTED' as const,evidenceIds,reason:'Fixture source.'}]};
  }))};
}
export async function reviewFixture(t: test.TestContext, options: { riskScore?:number|null; riskLevel?:'none'|'low'|'medium'|'high'; familyMigration?:boolean; lostResponse?:boolean; rejectSlot?:number; knownGenerationFailures?:number; rejected?: number; configured?: boolean; generationError?: boolean; mutate?: boolean; hold?: boolean; rotateKeyDuringPlan?: boolean; insufficient?: boolean; legacyPlan?: boolean; ipVerdict?: 'PASS'|'BLOCKED'|'UNCERTAIN'; generatedRisk?: boolean; riskFailure?: boolean } = {}) {
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
    imagePlan: async(imageContext:ProductImageContext,_fresh?:unknown,_repair?:unknown,_signal?:unknown,_workflowId?:unknown,onRequestSent?:()=>void)=>{onRequestSent?.();calls.push(imageContext.setPolicy&&!imageContext.slot?'set-plan':'plan');if(options.rotateKeyDuringPlan)configurationScope=randomUUID();return outputResult({...(imageContext.setPolicy&&!imageContext.slot?{setPlan:sceneSet()}:{}),kind:'image-plan',prompt:'Show this product',textMode:'none',expectedText:[],ipRisk:{verdict:options.ipVerdict??'PASS',findings:options.ipVerdict&&options.ipVerdict!=='PASS'?[{category:'character',name:'Mickey Mouse',evidence:'Distinctive named character in source image.',referenceAssetIds:[imageContext.referenceAssets[0].assetId]}]:[]},...(!options.legacyPlan?{productUnderstanding:{summary:'A blue round coaster with a raised rim.',referenceAssetIds:imageContext.referenceAssets.map(asset=>asset.assetId),uncertainties:options.insufficient?['Selected SKU cannot be identified.']:['Exact size is unknown.'],sufficient:!options.insufficient}}:{})});},
    reviewGeneratedImageRisk: async(_context:unknown,plan:AiResult,candidate:unknown)=>{calls.push('ip-check'); if(options.riskFailure)throw new AiError('SERVICE_PERMISSION_REQUIRED'); const value=outputResult({kind:'image-ip-review',candidate,planResultId:plan.id,service:'aigcViolationDetection',verdict:options.generatedRisk?'BLOCKED':'PASS',riskLevel:options.riskLevel??(options.generatedRisk?'high':'none'),labels:[{label:options.riskScore!==undefined||options.generatedRisk?'tm_goods':'nonLabel',confidence:options.riskScore!==undefined?options.riskScore:options.generatedRisk?99:null,description:options.generatedRisk?'疑似品牌商标':'未检出风险'}]});
      const context=_context as ProductImageContext,db=openDatabase(root);
      try{db.prepare('INSERT INTO ai_results VALUES(?,?)').run(value.id,JSON.stringify({...value,providerId:'aliyun-image-risk',productId:product.id,productRevision:product.revision,variantId:draft.variantId,assetId:null,assetSha256:null,sourceResultIds:[...(context.listingReviewResultId?[context.listingReviewResultId]:[]),plan.id],model:'aigcViolationDetection',createdAt:new Date().toISOString(),reviewState:'unreviewed',imageContext:context,...(context.listing.contract==='listing-full-schema/v1'?{listingEvidenceContractVersion:'listing-evidence/v4'}:{}),sourceSha256:listingFingerprint(context),imageRequestBytes:1}));}finally{db.close();}return value;},
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
  service.saveAppearanceReviewSettings({enabled:false}); // These historical-policy fixtures have no visual review provider.
  t.after(async()=>{release(); await service.close(); amazon.close(); store.close(); await rm(root,{recursive:true,force:true});});
  return {root,store,amazon,product,draft,familyPlan,service,calls,listing,ai,generation,generationInputs,release,began,reopen:()=>new ImageWorkflowService(root,store,amazon,ai as never,generation as never,{listing:listing as never}),run:()=>service.complete({draftId:draft.id,draftRevision:amazon.getDraft(draft.id).revision})};
}
