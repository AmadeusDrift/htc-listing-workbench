import { currentRiskRecheck } from './risk-adaptation.ts';
import { readImageRiskSettings } from '../image-workflow/risk-settings.ts';
import { imageWorkflowDraftStamp } from '../image-workflow/records.ts';
import { nonDeferredImageIssues,pricingBlockingReason,withoutDeferredImageRemaining } from '../image-workflow/deferred-fields.ts';
import { inspectImageAdaptation,saveImageAdaptation } from '../image-workflow/adaptation.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { AutomaticListingDependencies } from './service.ts';
import type { AutomaticAdaptationPreview, AutomaticAdaptationChange, AutomaticListingTask, AutomaticListingItem } from '../../shared/automatic-listing-contracts.ts';
import { FIELD_REPAIR_POLICY_VERSION, CATEGORY_FIELD_REPAIR_POLICY_VERSION } from '../../shared/automatic-listing-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { fingerprint } from '../execution/records.ts';
import { sourceStamp } from './records.ts';
import { previewSalesRecipes } from '../sales-plans/planning.ts';
import { outcomeScope, pricingOutcome, qualifiedPricing } from './outcomes.ts';
import type { SalesRecipe } from '../../shared/sales-plan-contracts.ts';
import type { AmazonDraft } from '../../shared/amazon-contracts.ts';

export const adaptationSubmitted=(draft:AmazonDraft|undefined)=>!!draft&&(!!draft.submittedAt||['SUBMITTING','SUBMITTED','PROCESSING','BUYABLE','DISCOVERABLE','UNKNOWN'].includes(draft.state));
const stable=(value:unknown):unknown=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)])):value;
const matchesRecipe=(row:AutomaticListingItem,recipe:SalesRecipe)=>row.salesPlan?row.salesPlan.recipe.key===recipe.key:recipe.components.length===1&&recipe.components[0].variantId===row.variantId&&recipe.components[0].quantity===recipe.components[0].sourcePackPieces;
export function adaptationState(task:AutomaticListingTask,deps:AutomaticListingDependencies,busy:boolean,db?:DatabaseSync){
  if(!deps.store.getProductSnapshot)throw new UserFacingError('此版本缺少只读来源接口，请更新后检查');
  const rules=deps.rules(),sources=[...new Set(task.items.map(r=>r.productId))].map(id=>deps.store.getProductSnapshot!(id));
  const receipts=sources.map(p=>deps.sourceReceipt?.(p.id)??null);
  const recipeErrors=new Map<string,string>();
  const recipes=new Map(sources.map((p,index)=>{try{return [p.id,deps.planSales?previewSalesRecipes(p,receipts[index],rules):[]] as const;}catch(error){recipeErrors.set(p.id,error instanceof Error?error.message:'销售选样资料不足');return [p.id,[] as ReturnType<typeof previewSalesRecipes>] as const;}}));
  const drafts=new Map(task.items.filter(r=>r.draftId).map(r=>[r.draftId!,deps.amazon.getDraft(r.draftId!)]));
  const runs=[...drafts.keys()].map(id=>deps.images.getProgress(id));
  const executions=deps.execution.list();
  const target=deps.amazon.executionTargetScope(task.targetId),profile=deps.hosting.getProfile(task.profileId);
  const blockers:string[]=[];
  if(busy||['RUNNING','QUEUED'].includes(task.status)||runs.some(r=>r?.status==='RUNNING')||executions.some(e=>['RUNNING','QUEUED'].includes(e.status)&&e.items.some(i=>drafts.has(i.draftId))))blockers.push('请求正在进行，请等待结果保存后重新检查；不会中断或取消请求');
  if(task.status==='CANCELLED')blockers.push('已取消任务仅保留历史');
  if(fingerprint(target)!==task.targetStamp||fingerprint(profile)!==task.profileStamp)blockers.push('店铺授权或图床范围变化，不能作为规则适配');
  const changes:AutomaticAdaptationChange[]=[];
  const add=(row:AutomaticListingItem,kind:AutomaticAdaptationChange['kind'],message:string,steps:string[]=[],fields:string[]=[])=>changes.push({key:row.key,productId:row.productId,sku:row.sku,kind,message,steps,fields});
  const projections=new Map<string,AmazonDraft>();
  for(const row of task.items){
    const draft=row.draftId?drafts.get(row.draftId):undefined,p=sources.find(p=>p.id===row.productId)!;
    if(adaptationSubmitted(draft)||['READBACK','LABELS','COMPLETE'].includes(row.stage)){add(row,'PRESERVED','已提交身份与历史保持不变，仅继续原平台回读');continue;}
    if(recipeErrors.has(p.id)){add(row,'BLOCKED',recipeErrors.get(p.id)!,['销售选样']);continue;}
    const selected=deps.planSales?recipes.get(p.id)!.some(r=>matchesRecipe(row,r)):p.variants.some(v=>v.id===row.variantId);
    if(!selected&&row.outcome?.kind==='RULE_FILTERED'&&row.outcome.pricingReport){add(row,'PRESERVED','原利润淘汰继续排除；本次也未选中，保留独立定价证据供后续重新入选时核对');continue;}
    if(!selected){if(row.outcome?.code!=='SKU_SELECTION_FILTERED')add(row,'NOT_SELECTED','按当前完整来源选样，本次未选中；保留历史、成果和次数');continue;}
    const priorRun=draft?deps.images.getProgress(draft.id):null;
    if(row.repair?.phase==='FIELDS_STARTED'||priorRun?.contentPreparation?.state==='STARTED'){
      if(p.revision!==row.productRevision||sourceStamp(p)!==row.sourceStamp)add(row,'BLOCKED','来源已变化，先恢复原字段请求归属和结果；保留原上下文与次数',['字段请求恢复']);
      else add(row,'PRESERVED','先按原检查点恢复字段请求结果；不改变原请求上下文或次数');
      continue;
    }
    if(row.outcome?.image&&currentRiskRecheck(db,row,draft,priorRun,p)){add(row,'RISK_RECHECK','原生成图评分按当前阈值不再拦截；继续时核验已有候选和原审核，不重复生图',['已有候选复核']);continue;}
    if(row.outcome?.image){add(row,'PRESERVED','原图片风险结论与检测证据保留，按图片规则单独复核');continue;}
    if(row.outcome?.code==='SKU_SELECTION_FILTERED')add(row,'SELECTED','当前选样已入选，恢复原身份；由用户继续缺失步骤',[row.stage]);
    if(sourceStamp(p)!==row.sourceStamp||p.revision!==row.productRevision)add(row,'SOURCE','来源版本已变化，保留原资料与成果；逐项本地重新校验',['字段依据','定价','图片依赖']);
    if(task.rulesStamp!==fingerprint(rules))add(row,'RULES','规则版本已变化；本地重算定价，未受影响字段和图片保留',['业务字段','定价']);
    if(draft&&deps.amazon.previewTaskAdaptation){
      try{
        const projected=deps.amazon.previewTaskAdaptation(draft.id,p,recipes.get(p.id)?.find(r=>matchesRecipe(row,r)));
        const image=inspectImageAdaptation(deps.images.getProgress(draft.id),draft,projected,p,db);
        if(!image.compatible&&pricingOutcome(projected,rules)?.kind!=='RULE_FILTERED'){add(row,'BLOCKED',image.message,['图片依赖']);continue;}
        projections.set(row.key,projected);
        const fields=[...new Set([...Object.keys(draft.attributes),...Object.keys(projected.attributes)])].filter(f=>fingerprint(draft.attributes[f]??null)!==fingerprint(projected.attributes[f]??null));
        if(fields.length||fingerprint(draft.localIssues)!==fingerprint(projected.localIssues)||fingerprint(draft.schema)!==fingerprint(projected.schema))add(row,'DRAFT','当前本地校验已重新计算；平台响应与旧错误留存于适配记录',['本地校验',...(fields.length?['字段']:[])],fields);
      }catch(error){add(row,'BLOCKED',error instanceof Error?error.message:'无法判定受影响范围，原成果保留');}
    }else if(draft&&(p.revision!==draft.productRevision||task.rulesStamp!==fingerprint(rules)))add(row,'BLOCKED','本地草稿适配接口不可用，保留原记录待修复');
  }
  for(const p of sources)for(const recipe of recipes.get(p.id)??[])if(!task.items.some(r=>r.productId===p.id&&matchesRecipe(r,recipe)))changes.push({key:p.id+':'+recipe.key,productId:p.id,sku:null,kind:'NEW',steps:['来源','分类','草稿'],fields:[],message:'当前完整来源选样新增销售规格：'+recipe.specification});
  const token=fingerprint(stable({version:1,task,rules,riskSettings:db?readImageRiskSettings(db):null,sources,receipts,drafts:[...drafts],runs,executions,target,profile,changes,projections:[...projections]}));
  const preview:AutomaticAdaptationPreview={taskId:task.id,taskRevision:task.revision,token,canApply:!blockers.length,blockers,changes,sources};
  return {preview,rules,sources,recipes,drafts,projections};
}
export function applyAdaptationRows(task:AutomaticListingTask,deps:AutomaticListingDependencies,state:ReturnType<typeof adaptationState>,db:DatabaseSync):void {
  const {rules,sources,recipes,drafts,preview}=state;
  task.rulesStamp=fingerprint(rules);task.ruleRevision=rules.revision;
  const now=new Date().toISOString();
  for(const row of task.items){
    const draft=row.draftId?drafts.get(row.draftId):undefined;
    if(adaptationSubmitted(draft)||['READBACK','LABELS','COMPLETE'].includes(row.stage))continue;
    const p=sources.find(p=>p.id===row.productId)!,changes=preview.changes.filter(c=>c.key===row.key);
    if(!changes.length||changes.every(c=>c.kind==='PRESERVED'))continue;
    if(changes.some(c=>c.kind==='BLOCKED')){if(row.status!=='SCREENED')row.status='FAILED';row.error??=changes.find(c=>c.kind==='BLOCKED')!.message;row.outcome??={version:1,kind:'SYSTEM_REPAIR',code:'SYSTEM_FAILURE',message:row.error,classifiedAt:now,scope:outcomeScope(task,row),draftId:row.draftId,draftRevision:draft?.revision??null};continue;}
    const recipe=recipes.get(p.id)?.find(r=>matchesRecipe(row,r));
    if(changes.some(c=>c.kind==='RISK_RECHECK')){if(!currentRiskRecheck(db,row,draft,draft?deps.images.getProgress(draft.id):null,p))throw new UserFacingError('当前风险解释或候选身份已变化');row.status='PENDING';delete row.outcome;continue;}
    if(row.outcome?.image&&!changes.some(c=>c.kind==='NOT_SELECTED'))continue;
    if(changes.some(c=>c.kind==='NOT_SELECTED')||row.outcome?.code==='SKU_SELECTION_FILTERED'&&!recipe&&deps.planSales){
      if(['EXECUTION','PARENT'].includes(row.stage))row.stage='IMAGES';
      row.status='SCREENED';row.outcome={version:1,kind:'RULE_FILTERED',code:'SKU_SELECTION_FILTERED',message:'按当前来源选样，本次未选中',classifiedAt:now,scope:outcomeScope(task,row),draftId:row.draftId,draftRevision:draft?.revision??null};continue;
    }
    if(recipe&&row.salesPlan)row.salesPlan={...row.salesPlan,recipe:structuredClone(recipe)};
    row.productRevision=p.revision;row.sourceStamp=sourceStamp(p);row.productTitle=p.title;row.stockSets=rules.product.stockSets;
    const updated=draft&&deps.amazon.applyTaskAdaptation?deps.amazon.applyTaskAdaptation(draft.id,p,recipe,db):draft;
    if(updated){
      if(draft&&pricingOutcome(updated,rules)?.kind!=='RULE_FILTERED')saveImageAdaptation(db,deps.images.getProgress(draft.id),draft,updated,p);
      if(draft&&row.repair&&row.repair.phase!=='FIELDS_STARTED'&&row.repair.draftRevision===draft.revision&&row.repair.draftStamp===imageWorkflowDraftStamp(draft)){
        const oldPricing=pricingBlockingReason(draft),newPricing=pricingBlockingReason(updated);
        row.repair={...row.repair,draftRevision:updated.revision,draftStamp:imageWorkflowDraftStamp(updated),remaining:[...new Set([...(newPricing?[newPricing]:[]),...withoutDeferredImageRemaining(updated,(row.repair.remaining??[]).filter(m=>m!==oldPricing)),...nonDeferredImageIssues(updated).map(issue=>issue.attributeNames.join('、')+'：'+issue.message)])].slice(0,100)};
      }
      const pricing=pricingOutcome(updated,rules);
      if(pricing){row.outcome={version:1,...pricing,message:(updated.businessRules?.notices.join('；')||'当前定价仍不合格或资料不足').slice(0,2000),classifiedAt:now,scope:outcomeScope(task,row),draftId:updated.id,draftRevision:updated.revision};row.status=pricing.kind==='RULE_FILTERED'?'SCREENED':'FAILED';continue;}
      if(row.outcome?.pricingReport&&!qualifiedPricing(updated,rules))throw new UserFacingError('旧利润淘汰尚无有效当前报价，不能恢复执行');
    }
    if(row.outcome?.code==='SKU_SELECTION_FILTERED'||row.outcome?.pricingReport){row.status='PENDING';delete row.outcome;}
    // System errors remain errors until actual local recovery or user continuation.
    if(row.outcome){row.outcome.scope=outcomeScope(task,row);if(updated)row.outcome.draftRevision=updated.revision;}
  }
  for(const source of sources){
    const missing=preview.changes.filter(c=>c.kind==='NEW'&&c.productId===source.id);if(!missing.length)continue;
    if(!deps.planSalesForAdaptation)throw new UserFacingError('缺少同事务销售身份分配接口');
    const plans=deps.planSalesForAdaptation(source,task.targetId,db);
    for(const change of missing){const plan=plans.find(p=>source.id+':'+p.recipe.key===change.key);if(!plan)throw new UserFacingError('应用期间销售选样发生变化');
      const existing=deps.existingSale?.(source.id,plan,task.targetId);
      if(existing&&task.items.some(r=>r.draftId===existing.id||r.sku===existing.sku))continue;
      if(existing)throw new UserFacingError('当前新增选样已存在独立草稿，请保留原身份核对，未新建重复销售项');
      if(task.items.some(r=>r.sku===plan.sku))throw new UserFacingError('新增选样与已有 SKU 身份冲突');
      task.items.push({key:change.key,productId:source.id,productRevision:source.revision,sourceStamp:sourceStamp(source),productTitle:source.title,variantId:plan.recipe.components[0].variantId,sku:plan.sku,salesPlan:plan,stockSets:rules.product.stockSets,sourcesPrepared:false,status:'PENDING',stage:'SOURCES',draftId:null,executionTaskIds:[],imageStarted:false,imageAttempts:0,repairAttempts:0,repairPolicyVersion:FIELD_REPAIR_POLICY_VERSION,categoryFieldPolicyVersion:CATEGORY_FIELD_REPAIR_POLICY_VERSION,repair:null,batchId:null,error:null});
    }
  }
  task.status='PAUSED';
}

export function assertTaskAdaptationHistory(db:DatabaseSync,task:AutomaticListingTask):void{
  if(!task.adaptation)return;
  const saved=db.prepare("SELECT detail_json FROM audit_events WHERE action='automatic-listing.adapted' AND json_extract(detail_json,'$.token')=? ORDER BY rowid DESC LIMIT 1").get(task.adaptation.token);
  if(!saved)throw new UserFacingError('旧任务适配检查点缺少原始历史');
  const proof=JSON.parse(String(saved.detail_json)),before=proof.before as AutomaticListingTask;
  const previous=[...(before.adaptation?.previousRules??[]),{stamp:before.rulesStamp,revision:before.ruleRevision}].filter((r,i,a)=>a.findIndex(v=>v.stamp===r.stamp&&v.revision===r.revision)===i);
  const blocked=proof.changes.filter((c:AutomaticAdaptationChange)=>c.kind==='BLOCKED').map((c:AutomaticAdaptationChange)=>c.key);
  if(proof.taskId!==task.id||before.id!==task.id||fingerprint(previous)!==fingerprint(task.adaptation.previousRules)||fingerprint(blocked)!==fingerprint(task.adaptation.blockedKeys))throw new UserFacingError('旧任务适配检查点与原始历史不一致');
}
