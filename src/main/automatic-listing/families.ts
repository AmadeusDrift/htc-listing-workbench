import type { AmazonService } from '../amazon/service.ts';
import type { ListingAiService } from '../listing-ai/service.ts';
import type { ExecutionService } from '../execution/service.ts';
import type { FollowupService } from '../followup/service.ts';
import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { SalesListingPlan } from '../../shared/sales-plan-contracts.ts';
import { chooseVariationTheme } from '../sales-plans/families.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { isSameSalesFamily } from '../sales-plans/family-binding.ts';

export async function resolveSalesFamily(amazon:Pick<AmazonService,'getSchema'>,input:{plans:SalesListingPlan[];targetId:string;productType:string;locale:string},signal:AbortSignal):Promise<SalesListingPlan[]> {
  const schema=await amazon.getSchema({targetId:input.targetId,productType:input.productType,locale:input.locale,requirements:'LISTING',parentageLevel:'CHILD'});
  if(signal.aborted)throw new UserFacingError('自动任务已暂停');
  const theme=input.plans.every(p=>p.namingChildKey!==null)?chooseVariationTheme(schema,input.plans.map(p=>p.recipe)):null;
  return input.plans.map(plan=>({...plan,familyResolved:true,parentage:theme?'CHILD':'NONE',parentSku:theme?plan.baseSku:null,variationTheme:theme,
    relationReason:theme?`同款同规格；当前类目允许 ${theme} 变体`:'当前类目没有适用且未弃用的变体主题，按独立商品上架'}));
}
export async function ensureFamilyParent(deps:{amazon:AmazonService;listing:ListingAiService;execution:ExecutionService;followup:FollowupService},child:AmazonDraft,profileId:string,signal:AbortSignal,hostingRoute?:import('../../shared/hosting-contracts.ts').HostingRoute):Promise<{draftId:string;ready:boolean}> {
  const check=()=>{if(signal.aborted)throw new UserFacingError('自动任务已暂停');};check();
  const plan=child.salesPlan;if(plan?.parentage!=='CHILD')throw new UserFacingError('当前商品没有父体关系');
  const parentPlan=deps.amazon.familyParentPlan(child);
  let parent=deps.amazon.listDrafts(child.productId).find(draft=>draft.sku===parentPlan.sku&&draft.targetId===child.targetId);
  if(parent && (!parent.salesPlan||!isSameSalesFamily(parent.salesPlan,plan)||parent.schema.parentageLevel!=='PARENT'||parent.schema.productType!==child.schema.productType))throw new UserFacingError('父 SKU 已被不同商品或关系占用');
  if(!parent){
    const result=await deps.amazon.prepareDrafts({parentageLevel:'PARENT',listingProgram:child.listingProgram,
      // Only the public selection keys are accepted by the preparation parser.
      targetId:child.targetId,productType:child.schema.productType,locale:child.schema.locale,requirements:'LISTING',
      items:[{productId:child.productId,productRevision:child.productRevision,variantId:child.variantId,attributes:{}}]},[parentPlan]);
    parent=result.items[0]?.draft??undefined;
    if(!parent)throw new UserFacingError(result.items[0]?.error||'父体草稿准备失败');
  }
  check();
  if(!parent.submittedAt&&!['SUBMITTING','UNKNOWN'].includes(parent.state)){
    const existing=deps.execution.list().filter(t=>!['CANCELLED','COMPLETED'].includes(t.status)&&t.items.some(i=>i.draftId===parent!.id));
    if(existing.length>1||existing.some(t=>t.items.length!==1||t.items[0].draftId!==parent!.id||t.profileId!==profileId))throw new UserFacingError('父体已在不同范围的执行任务中，未启动其它商品');
    let task:(typeof existing)[number]|undefined=existing[0];
    if(task&&['NEEDS_ATTENTION','PAUSED'].includes(task.status)&&!task.items[0].submitStarted
      &&task.items[0].steps.some(step=>step.status==='FAILED'&&['validate','preview'].includes(step.name))){
      parent=deps.amazon.applyBusinessDefaults({id:parent.id,revision:parent.revision});
      // A corrected draft is a new validation scope, including after a restart
      // between saving defaults and retiring the failed execution. Keep every
      // failed attempt; unchanged fields never receive another execution here.
      if(parent.revision!==task.items[0].draftRevision){check();deps.execution.cancel(task.id);task=undefined;}
    }
    if(!task){
      parent=deps.amazon.useFamilyImage(parent.id,child.id);
      parent=(await deps.listing.complete({draftId:parent.id,draftRevision:parent.revision},signal)).draft;
      check();task=deps.execution.create({draftIds:[parent.id],profileId,concurrency:1,...(hostingRoute?{hostingRoute}:{})});
    }
    for(;;){
      const previous=deps.execution.get(task.id),item=previous.items[0],step=item?.steps.find(s=>s.status==='FAILED');
      if(step){
        const priorFailures=deps.execution.list().filter(t=>t.items.length===1&&t.items[0].draftId===parent!.id&&t.items[0].steps.some(s=>s.status==='FAILED'&&['validate','preview','submit'].includes(s.name))).length;
        if(item.submitStarted||!['validate','preview','submit'].includes(step.name)||priorFailures>=3)throw new UserFacingError(step.error||previous.error||'父体尚未建档，保留子体进度');
        parent=(await deps.listing.complete({draftId:parent.id,draftRevision:parent.revision},signal)).draft;
        check();deps.execution.cancel(task.id);task=deps.execution.create({draftIds:[parent.id],profileId,concurrency:1,...(hostingRoute?{hostingRoute}:{})});
      }
      const stop=()=>deps.execution.pause(task!.id);signal.addEventListener('abort',stop,{once:true});
      try{check();deps.execution.startAuthorized(deps.execution.prepareStart(task.id));await deps.execution.waitForIdle();}
      finally{signal.removeEventListener('abort',stop);}
      check();parent=deps.amazon.getDraft(parent.id);
      if(parent.submittedAt||['SUBMITTING','UNKNOWN'].includes(parent.state))break;
      if(!deps.execution.get(task.id).items[0]?.steps.some(s=>s.status==='FAILED'))throw new UserFacingError('父体尚未建档，保留子体进度');
    }
  }
  if(parent.mode==='demo')return {draftId:parent.id,ready:true};
  const followup=deps.followup.schedule(parent.id);
  if(followup.status==='NEEDS_ATTENTION')throw new UserFacingError(followup.error||'父体回读有错误，保留子体进度');
  return {draftId:parent.id,ready:followup.status==='READY'};
}
