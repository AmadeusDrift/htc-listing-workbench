// Test-only normal factory: real production services and current index.ts owner wiring.
import assert from 'node:assert/strict';
import type {SecretStorage} from '../../../src/main/amazon/vault.ts';
import {createBatchReferencePort} from '../../../src/main/hosting/batch-references.ts';
import {imageWorkflowDraftStamp} from '../../../src/main/image-workflow/approval-reuse.ts';
import {UserFacingError} from '../../../src/shared/errors.ts';
import { WorkspaceStore } from '../../../src/main/store.ts';
import { AmazonService } from '../../../src/main/amazon/service.ts';
import { HostingService } from '../../../src/main/hosting/service.ts';
import { createPublicImageProbe } from '../../../src/main/hosting/public-probe.ts';
import { AiService } from '../../../src/main/ai/service.ts';
import { ImageGenerationService } from '../../../src/main/image-generation/service.ts';
import { normalizeGeneratedImage } from '../../../src/main/image-generation/normalize.ts';
import { decodePreview } from '../../../src/main/ipc.ts';
import { MiaoshouService } from '../../../src/main/miaoshou/service.ts';
import { MiaoshouImageService, createSourceImageDownloader } from '../../../src/main/miaoshou/images.ts';
import { ImageWorkflowService } from '../../../src/main/image-workflow/service.ts';
import { ListingAiService } from '../../../src/main/listing-ai/service.ts';
import { ExecutionService } from '../../../src/main/execution/service.ts';
import { FollowupService } from '../../../src/main/followup/service.ts';
import { CatalogService } from '../../../src/main/catalog/service.ts';
import { ProcurementService } from '../../../src/main/procurement/service.ts';
import { ItemLabelService } from '../../../src/main/item-labels/service.ts';
import { ItemLabelSettings } from '../../../src/main/item-labels/settings.ts';
import { SkuNamingService } from '../../../src/main/sku-naming/service.ts';
import { ListingRuleStore, readListingRules } from '../../../src/main/listing-rules.ts';
import { AutomaticListingService } from '../../../src/main/automatic-listing/service.ts';
import { planSalesListings } from '../../../src/main/sales-plans/planning.ts';
import { resolveSalesFamily, ensureFamilyParent } from '../../../src/main/automatic-listing/families.ts';
import { classifyProduct } from '../../../src/main/catalog/classification.ts';
import { assertConsistencyView } from '../../../src/main/source-image-consistency/proof.ts';

export function createNormalServices(dataRoot:string,storage:SecretStorage,fetcher:typeof fetch,now:()=>Date,followupNow:()=>number=Date.now){
  const resolve=async(host:string)=>{assert.ok(['cbu01.alicdn.com','htc.185858.xyz','selling-partner-definitions-prod-iad.s3.amazonaws.com'].includes(host),'S10_UNREGISTERED_DNS');return ['198.18.0.1'];};
  const lookup=async(host:string)=>(await resolve(host)).map(address=>({address,family:4}));
  const store=new WorkspaceStore(dataRoot),db=store;
  const amazon=new AmazonService(dataRoot,id=>store.getProductSnapshot(id),storage,{fetch:fetcher,schemaFetch:fetcher,dataFetch:fetcher,resolveAddresses:resolve,now:()=>now().getTime()});
  const hosting=new HostingService(dataRoot,store,storage,{probe:createPublicImageProbe({nativeFetch:fetcher,lookup})});
  const generation=new ImageGenerationService(dataRoot,store,storage,{fetch:fetcher,decodePreview,normalizeImage:normalizeGeneratedImage,downloadDependencies:{nativeFetch:fetcher,lookup}}),generationService=generation;
  let automatic:AutomaticListingService;
  const batchReferences=createBatchReferencePort({directory:dataRoot,store,generation,hosting,task:id=>automatic.get(id),probe:createPublicImageProbe({nativeFetch:fetcher,lookup})});
  const ai=new AiService(dataRoot,store,hosting,storage,{fetch:fetcher,nonce:()=>'s10-normal-nonce',batchReferences,imageGenerationCapability:()=>generation.capability()});
  generation.attachOpenRouterConnection({read:()=>ai.openRouterApiKey(),save:key=>ai.saveConnection({id:'openrouter',apiKey:key}),disconnect:()=>ai.disconnectConnection('openrouter')});
  const source=new MiaoshouService(dataRoot,store,storage,{fetch:fetcher,now}),miaoshouService=source;
  const sourceImages=new MiaoshouImageService(dataRoot,store,id=>source.getReceipt(id),decodePreview,{getSourceUpdate:id=>source.getSourceUpdate(id),download:createSourceImageDownloader({nativeFetch:fetcher,lookup})});
  const images=new ImageWorkflowService(dataRoot,store,amazon,ai,generation,{sources:{getReceipt:id=>source.getReceipt(id),images:sourceImages}}),workflowService=images,imageWorkflow=images;
  const listing=new ListingAiService(store,amazon,ai,()=>images.getCopyReviewSettings().enabled),listingService=listing,amazonService=amazon,aiService=ai;
  const followup=new FollowupService(dataRoot,amazon,{now:followupNow}),listingFollowup=followup,catalog=new CatalogService(dataRoot,amazon),catalogService=catalog,procurement=new ProcurementService(dataRoot,store,amazon);
  const execution=new ExecutionService(dataRoot,store,amazon,hosting,{scheduleFollowup:id=>followup.schedule(id)}),executionService=execution,labels=new ItemLabelService(dataRoot,amazon,procurement);
  const labelSettings=new ItemLabelSettings(dataRoot),formatSettings=labelSettings,naming=new SkuNamingService(dataRoot),namingService=naming,rules=new ListingRuleStore(dataRoot),ruleStore=rules;
  automatic = new AutomaticListingService(dataRoot, {
    store: db, amazon, hosting, images: imageWorkflow, execution, followup, procurement, labels,
    batch:aiService.batchTasks,batchPlan:()=>aiService.taskBatchPlan(),
    rules: () => ruleStore.get(),
    labelFormat: () => formatSettings.get(),
    sourceReceipt: productId => miaoshouService.getReceipt(productId),
    planSalesForAdaptation: (source,targetId,transactionDb) => {const naming=new SkuNamingService(dataRoot,transactionDb);return planSalesListings(source,miaoshouService.getReceipt(source.id),amazonService.getTarget(targetId),readListingRules(transactionDb),naming,{existingPlans:()=>[...amazonService.readSalesPlans(source.id,targetId),...(automatic?.readSalesPlans(source.id,targetId)??[])]});},
    planSales: (productId,targetId) => {return planSalesListings(db.getProductSnapshot(productId),miaoshouService.getReceipt(productId),amazonService.getTarget(targetId),ruleStore.get(),namingService,{existingPlans:()=>[...amazonService.readSalesPlans(productId,targetId),...(automatic?.readSalesPlans(productId,targetId)??[])]});},
    existingSale:(productId,plan,targetId)=>amazonService.findSalesDraft(productId,plan,targetId),
    resolveFamily: (input,signal) => resolveSalesFamily(amazonService,input,signal),
    rebindFamily: (input,signal) => amazonService.rebindUnsubmittedFamily(input,signal),
    ensureParent: (child,profileId,signal) => ensureFamilyParent({amazon:amazonService,listing:listingService,execution:executionService,followup:listingFollowup},child,profileId,signal),
    classify: async (input, signal) => {
      if (!catalogService.get(input.targetId)) await catalogService.sync(input.targetId);
      const scope = JSON.stringify(amazonService.executionTargetScope(input.targetId));
      const fresh = () => { if (signal.aborted || JSON.stringify(amazonService.executionTargetScope(input.targetId)) !== scope) throw new UserFacingError('分类期间目标已变化或任务已暂停'); };
      return classifyProduct(input, {
        keywords: value => aiService.decideCategory({...value,phase:'keywords',candidates:[]},fresh,signal),
        search: (targetId,query) => catalogService.search({targetId,query}),
        localCandidates: targetId => catalogService.get(targetId)?.productTypes??[],
        fallback: (targetId,keywords) => amazonService.searchProductTypes({targetId,keywords}),
        choose: (value,phase) => aiService.decideCategory({...value,phase},fresh,signal),
      });
    },
    preflight: () => {
      for(const purpose of ['source_understanding','category_analysis','category_decision','listing_completion','image_plan','image_text_review'] as const){
        const profile=aiService.purposeProfile(purpose,['source_understanding','category_analysis','category_decision','image_plan'].includes(purpose),purpose==='image_text_review');
        if(!profile.configured||!profile.enabled)throw new UserFacingError(`用途 ${purpose} 的 ${profile.routing?.gateway} 连接尚未配置或启用，请在逐用途设置中核对`);
      }
      for (const id of ['aliyun-ocr',...(workflowService.getRiskSettings().enabled?['aliyun-image-risk']:[])]) {
        const profile = aiService.getProfile(id); if (!profile.configured || !profile.enabled) throw new UserFacingError('请先在设置中配置并启用内容生成、内容复核、OCR 和侵权检测');
      }
      const generation = generationService.getConnection(); if (!generation.configured || !generation.enabled) throw new UserFacingError('请先在设置中配置并启用生图服务');
    },
    prepareSourceConsistency: async (input,signal,fresh) => {
      for(const variantId of input.variantIds){fresh();const view=await aiService.prepareSourceConsistency({productId:input.productId,productRevision:input.productRevision,variantId},signal,fresh);fresh();assertConsistencyView(view);}
    },
    prepareSourceColors: async (id, signal) => {
      const current=amazonService.getDraft(id);
      return listingService.prepareSourceColors({draftId:id,draftRevision:current.revision},signal);
    },
    beginLegacyThemeRepair: (id,row,workflow) => listingService.beginLegacyThemeRepair(id,row,workflow)?.id,
    beginFieldRepair: id => {const current=amazonService.getDraft(id);return listingService.beginCompletion({draftId:id,draftRevision:current.revision}).id;},
    repairFields: async (id, signal, operationId) => {
      const current = amazonService.getDraft(id);
      return await listingService.complete({ draftId: id, draftRevision: current.revision }, signal, operationId);
    },
    recheckUnitImage:async(input,signal,authorize)=>{const result=await workflowService.recheckUnitAdoption(input,signal,authorize);if(result.workflow.status!=='COMPLETED')throw new UserFacingError(result.workflow.error||'计量复核的部分图片尚未通过；原标记保留');return result.draft;},
    recheckImage: async (input, signal) => {
      if (signal.aborted) throw new UserFacingError('自动任务已暂停');
      const draft = amazonService.getDraft(input.draftId), prior = workflowService.getProgress(input.draftId);
      workflowService.assertSourceConsistency(draft.id);
      if (prior?.status === 'COMPLETED' && workflowService.isRiskPolicyCompatible(prior) && workflowService.isCopyReviewPolicyCompatible(prior) && prior.draftSha256 === imageWorkflowDraftStamp(draft) && prior.recheckedFromRunId === input.sourceWorkflowId) return draft;
      const cancel = () => workflowService.cancel(input.draftId); signal.addEventListener('abort', cancel, { once: true });
      try {
        const result = await workflowService.recheck(input);
        if (result.workflow.status !== 'COMPLETED') throw new UserFacingError(result.workflow.error || '修复后的文案与现有图片复核未通过');
        return result.draft;
      } finally { signal.removeEventListener('abort', cancel); }
    },
  });
  return {store,amazon,hosting,generation,ai,source,sourceImages,images,listing,followup,catalog,procurement,execution,labels,labelSettings,naming,rules,automatic,
    async close(){for(const service of [automatic,labels,labelSettings,followup,catalog,procurement,images,generation,sourceImages,source,ai,execution,hosting,naming,rules,amazon,store])await service.close();}
  };
}
