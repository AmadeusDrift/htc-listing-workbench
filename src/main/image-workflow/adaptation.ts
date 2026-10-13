import { appendAuditEvent } from '../storage/audit.ts';
import { readImageRiskSettings } from './risk-settings.ts';
import { semanticJson } from '../amazon/preparation.ts';
import { imageRiskSourceSnapshot } from '../ai/image-validation.ts';
import { imageActualInputsMatch } from './context-compatibility.ts';
import type { ListingAiContext } from '../../shared/listing-ai-contracts.ts';
import type { SalesRecipe } from '../../shared/sales-plan-contracts.ts';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { ImageWorkflowRun } from '../../shared/image-workflow-contracts.ts';
import { hasSevenApprovedImages } from '../../shared/image-workflow-contracts.ts';
import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { ProductDetail } from '../../shared/contracts.ts';
import { fingerprint as rawFingerprint } from '../execution/records.ts';
import { sameSchemaValidation } from '../amazon/schema-compatibility.ts';
import { compatibleApprovalRecipe, imageApprovalDraftSnapshot } from './approval-reuse.ts';

const fingerprint=(value:unknown)=>rawFingerprint(semanticJson(JSON.parse(JSON.stringify(value))));
export const workflowHash=(run:ImageWorkflowRun)=>fingerprint(run);
const approvalHash=(draft:AmazonDraft)=>rawFingerprint(JSON.parse(imageApprovalDraftSnapshot(draft)));
function approvedBaseline(db:DatabaseSync|undefined,run:ImageWorkflowRun,before:AmazonDraft):AmazonDraft|undefined{
  if(approvalHash(before)===run.draftSha256)return before;
  if(!db)return undefined;
  for(const row of db.prepare("SELECT detail_json FROM audit_events WHERE action='image.workflow.task-adapted' AND json_extract(detail_json,'$.workflowId')=? ORDER BY rowid DESC LIMIT 1000").all(run.id)){
    const proof=JSON.parse(String(row.detail_json)),original=proof.approvedBefore??proof.before;
    if(proof.workflowHash===workflowHash(run)&&imageApprovalDraftSnapshot(proof.after)===imageApprovalDraftSnapshot(before)&&approvalHash(original)===run.draftSha256)return original;
  }
  return undefined;
}
/** Exact dependency proof authorizes current use, never rewrites a paid request. */
export function inspectImageAdaptation(run:ImageWorkflowRun|null|undefined,before:AmazonDraft,after:AmazonDraft,source:ProductDetail,db?:DatabaseSync):{compatible:boolean;message:string}{
  if(!run)return {compatible:true,message:'尚无图片请求；沿用来源图片，后续只执行缺失步骤'};
  if(before.productRevision===after.productRevision){
    if(!sameSchemaValidation(before.schema,after.schema)&&!hasSevenApprovedImages(run))return {compatible:false,message:'类目字段约束变化；保留已付费图片和次数，旧的部分图片需要逐图依赖适配'};
    return {compatible:true,message:'来源版本未变，保留全部图片及次数；继续时按已有字段/图片依赖复核'};
  }
  const approved=approvedBaseline(db,run,before);
  if(!approved)return {compatible:false,message:'当前草稿未绑定原图片审核快照，保留原图并重新核对改动内容'};
  const old=run.imageContext?.listing.sourceProduct;
  if(!hasSevenApprovedImages(run)){const blocked=(db?partialRiskModeBlocker(run,readImageRiskSettings(db).enabled):null)??partialSourceBlocker(run);if(blocked)return {compatible:false,message:blocked};}
  if(!run.imageContext)return {compatible:false,message:'来源版本变化；已付费图片和次数保留，旧请求上下文不足以安全接续，需核对具体图片依赖'};
  const frozenRecipe=old?.salesRecipe?.recipe??approved.salesPlan?.recipe??null;
  const visibleRecipe=(recipe:SalesRecipe|null)=>recipe?{...recipe,totalCostCny:null,components:recipe.components.map(c=>({...c,quotedCostCny:null}))}:null;
  if(!compatibleApprovalRecipe(run,frozenRecipe)||fingerprint(visibleRecipe(frozenRecipe))!==fingerprint(visibleRecipe(after.salesPlan?.recipe??null))||!sameSchemaValidation(before.schema,after.schema))return {compatible:false,message:'销售组合或类目字段约束变化；原图保留，需重新核对对应图片'};
  const ids=new Set(after.salesPlan?.recipe.components.map(c=>c.variantId)??[after.variantId]);
  const values=(variants:ProductDetail['variants'])=>variants.filter(v=>ids.has(v.id)).map(({purchasePrice:_p,sourcePurchasePrice:_s,inventory:_i,...v})=>v).sort((a,b)=>a.id.localeCompare(b.id));
  const sourceMatches=old?fingerprint(values(old.variants??[old.selectedSku]))===fingerprint(values(source.variants))&&old.title===source.title&&old.description===source.description&&fingerprint(old.facts)===fingerprint(source.facts):ids.size===1&&ids.has(run.variantId)&&run.imageContext.listing.unverifiedSourceTitle===source.title&&!!run.imageContext.ipSource&&fingerprint(run.imageContext.ipSource)===fingerprint(imageRiskSourceSnapshot(source,run.variantId));
  if(!sourceMatches)return {compatible:false,message:'来源商品描述或所选规格事实变化；原图保留，仅对应图片依赖待核对'};
  const business=new Set(['purchasable_offer','list_price','item_package_dimensions','item_package_weight']);
  const visible=(draft:AmazonDraft)=>Object.fromEntries(Object.entries(draft.attributes).filter(([field])=>!business.has(field)));
  if(fingerprint(visible(approved))!==fingerprint(visible(before))||fingerprint(visible(before))!==fingerprint(visible(after)))return {compatible:false,message:'可见属性或文案变化；保留原图，需对应内容复核'};
  if(!run.referenceAssets.every(ref=>source.assets.some(a=>a.id===ref.id&&a.variantIds.some(id=>ids.has(id)))))return {compatible:false,message:'原参考图或规格关联已变化；保留原图待核对'};
  return {compatible:true,message:'仅成本/库存或无关来源版本变化；所选规格、文案及图片事实一致，保留已通过图位，接续未完成步骤'};
}
export function saveImageAdaptation(db:DatabaseSync,run:ImageWorkflowRun|null|undefined,before:AmazonDraft,after:AmazonDraft,source:ProductDetail):void{
  if(!run||before.productRevision===after.productRevision)return;
  if(!db.isTransaction)throw new Error('Image adaptation requires task transaction');
  const decision=inspectImageAdaptation(run,before,after,source,db);if(!decision.compatible)throw new Error(decision.message);
  const references=run.referenceAssets.map(ref=>{const asset=db.prepare('SELECT sha256 FROM assets WHERE id=? AND product_id=?').get(ref.id,source.id);if(asset?.sha256!==ref.sha256)throw new Error('原参考图内容已变化');return ref;});
  appendAuditEvent(db,randomUUID(),source.id,'image.workflow.task-adapted',decision.message,JSON.stringify({workflowId:run.id,workflowHash:fingerprint(run),approvedBefore:approvedBaseline(db,run,before),before,after,sourceHash:fingerprint(source),references}),new Date().toISOString());
}
export function currentImageAdaptation(db:DatabaseSync,run:ImageWorkflowRun,draft:AmazonDraft,source:ProductDetail):boolean{
  const row=db.prepare("SELECT detail_json FROM audit_events WHERE action='image.workflow.task-adapted' AND json_extract(detail_json,'$.workflowId')=? ORDER BY rowid DESC LIMIT 1").get(run.id);if(!row)return false;
  const proof=JSON.parse(String(row.detail_json));
  return proof.workflowHash===fingerprint(run)&&proof.sourceHash===fingerprint(source)&&imageApprovalDraftSnapshot(proof.after)===imageApprovalDraftSnapshot(draft)&&inspectImageAdaptation(run,proof.before,draft,source,db).compatible
    &&run.referenceAssets.every(ref=>db.prepare('SELECT sha256 FROM assets WHERE id=? AND product_id=?').get(ref.id,source.id)?.sha256===ref.sha256);
}

/** Normalize only the proven source revision and original cost-bearing recipe.
 * Every other finite-context identity/source check still runs on current inputs. */
export function adaptedImageInputsMatch(db:DatabaseSync,run:ImageWorkflowRun,draft:AmazonDraft,source:ProductDetail,current:ListingAiContext):boolean{
  if(!run.imageContext||!currentImageAdaptation(db,run,draft,source))return false;
  const original=approvedBaseline(db,run,draft);if(!original)return false;
  return imageActualInputsMatch(run.imageContext,{...draft,salesPlan:original.salesPlan,productRevision:run.productRevision},{...source,revision:run.productRevision},{...current,productRevision:run.productRevision},run.imageRecipeSha256);
}

export function partialSourceBlocker(run:ImageWorkflowRun):string|null{
  if(run.status==='RUNNING')return '旧图片请求仍在进行，等待原结果保存后再适配';
  if(!run.slots||!run.imageContext||!run.setPlan||!run.setPlanResultId)return '部分图片尚缺完整原规划上下文；保留记录待核对';
  if(run.sourceReuse||run.approvalReuse||run.recheckedFromRunId)return '此来源已存在图片派生关系，保留全部图位及次数待核对';
  if(run.copyReviewEnabled!==false||!run.imageContext.copyReviewBypass)return '旧文案审核上下文需要单独复核，保留已通过图片';
  if(run.imageContext.referenceMeasurements?.length)return '原图 OCR 尺寸依据仍绑定旧来源版本，保留图片和原始依据待核对';
  if(run.contentPreparation?.state==='STARTED'||run.contentPreparation?.remaining.length)return '先完成原字段检查点，保留图片及请求次数';
  if(run.slots.some(slot=>slot.status!=='PASSED'&&slot.attempts.some(attempt=>attempt.state!=='RETRYABLE_FAILURE'||attempt.candidateId!==null)))return '旧图位尚有待恢复的请求或候选，须按原身份恢复；未清除请求或重置次数';
  return null;
}
export function assertPartialSourceReuse(run:ImageWorkflowRun,source:ImageWorkflowRun|undefined,db?:DatabaseSync):void{
  const proof=run.sourceReuse;if(!proof)return;
  const invalid=()=>{throw new Error('部分图片派生记录与原始上下文或尝试次数不一致');};
  if(run.id!==proof.derivationRunId&&run.approvalReuse?.sourceRunId!==proof.derivationRunId)invalid();
  if(!source||source.id!==proof.sourceRunId||source.id===run.id||workflowHash(source)!==proof.sourceRunHash||partialSourceBlocker(source)||source.draftId!==run.draftId||source.productId!==run.productId||source.variantId!==run.variantId||source.sku!==run.sku||source.productRevision!==proof.sourceProductRevision||run.productRevision<=source.productRevision||run.maxAttempts!==source.maxAttempts||run.legacyImageAttempts!==source.legacyImageAttempts||run.copyRepairAttempts!==source.copyRepairAttempts||run.copyReviewEnabled!==source.copyReviewEnabled||run.riskInterceptionEnabled!==source.riskInterceptionEnabled||source.createdAt>run.createdAt||fingerprint(source.referenceAssets)!==fingerprint(run.referenceAssets)||fingerprint(source.imageContext)!==fingerprint(proof.sourceContext)||source.setPlanResultId!==run.setPlanResultId||fingerprint(source.setPlan)!==fingerprint(run.setPlan))invalid();
  if(db){
    const saved=db.prepare("SELECT detail_json FROM audit_events WHERE action='image.workflow.partial-source-derived' AND json_extract(detail_json,'$.workflowId')=? ORDER BY rowid DESC LIMIT 1").get(proof.derivationRunId);
    const receipt=saved?JSON.parse(String(saved.detail_json)):undefined;
    if(!receipt||receipt.sourceRunId!==source!.id||receipt.sourceRunHash!==proof.sourceRunHash||receipt.productRevision!==run.productRevision||receipt.contextSha256!==run.contextSha256)invalid();
  }
  for(const [index,slot] of run.slots!.entries()){
    const old=source!.slots![index],count=proof.slotAttempts[index];
    if(count!==old.attempts.length||proof.slotContexts[index]!==old.contextSha256||fingerprint(slot.attempts.slice(0,count))!==fingerprint(old.attempts)||old.status==='PASSED'&&fingerprint(slot)!==fingerprint(old))invalid();
  }
}

export function partialRiskModeBlocker(run:ImageWorkflowRun,currentEnabled:boolean):string|null{
  return currentEnabled!==(run.riskInterceptionEnabled!==false)?'风险开关与原部分图片流程不同；此来源接续暂不支持同时切换风险模式，原记录与次数保持不变':null;
}
