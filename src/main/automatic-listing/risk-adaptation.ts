import { sourceStamp } from './records.ts';
import { compatibleApprovalRecipe } from '../image-workflow/approval-reuse.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { AutomaticListingItem } from '../../shared/automatic-listing-contracts.ts';
import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { ProductDetail } from '../../shared/contracts.ts';
import type { ImageWorkflowRun } from '../../shared/image-workflow-contracts.ts';
import { validateStoredAiResult,validateAiCall } from '../ai/validation.ts';
import { resultHasOwner } from '../ai/result-owner.ts';
import { evaluateImageRisk } from '../../shared/image-risk-policy.ts';
import { readImageRiskSettings } from '../image-workflow/risk-settings.ts';
import { imageWorkflowDraftStamp } from "../image-workflow/approval-reuse.ts";
import { listingFingerprint } from "../json-fingerprint.ts";

/** Admission to recheck an existing candidate, never a new PASS or generation grant. */
export function currentRiskRecheck(db:DatabaseSync|undefined,row:AutomaticListingItem,draft:AmazonDraft|undefined,run:ImageWorkflowRun|null|undefined,source:ProductDetail):boolean{
 if(!db||!draft||!run||row.sourceStamp!==sourceStamp(source)||!compatibleApprovalRecipe(run,draft.salesPlan?.recipe??null))return false;
 const proof=row.outcome?.image;if(proof?.kind!=='IP_IMAGE_BLOCKED'||proof.workflowId!==run.id||proof.draftRevision!==draft.revision||run.draftSha256!==imageWorkflowDraftStamp(draft)||run.productRevision!==source.revision||draft.productRevision!==source.revision||run.variantId!==draft.variantId||run.productId!==source.id||run.draftId!==draft.id||run.status==='RUNNING')return false;
 const settings=readImageRiskSettings(db);if(!settings.enabled)return false;
 try{
  const saved=db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(proof.resultId),callSaved=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(proof.callId);if(!saved||!callSaved)return false;
  const result=validateStoredAiResult(JSON.parse(String(saved.record_json))),call=validateAiCall(JSON.parse(String(callSaved.record_json))),context=result.imageContext;
  if(!resultHasOwner(result,call)||result.callId!==proof.callId||result.id!==proof.resultId||result.output.kind!=='image-ip-review'||result.output.candidate.id!==proof.candidateId||result.output.planResultId!==proof.planResultId||result.productId!==source.id||result.productRevision!==source.revision||result.variantId!==draft.variantId||!context||listingFingerprint(context)!==proof.contextSha256||result.sourceSha256!==proof.contextSha256||context.listing.draftId!==draft.id||context.listing.draftRevision!==draft.revision||context.listing.sku!==draft.sku||listingFingerprint(context.referenceAssets.map(ref=>({id:ref.assetId,sha256:ref.sha256})))!==listingFingerprint(proof.references))return false;
  const attempt=run.slots?.find(slot=>slot.index===context.slot?.index)?.attempts.at(-1);
  if(attempt?.candidateId!==proof.candidateId||attempt.ipReviewResultId!==proof.resultId||attempt.planResultId!==proof.planResultId||attempt.state!=='BLOCKED')return false;
  if(!proof.references.every(ref=>source.assets.some(asset=>asset.id===ref.id)&&db.prepare('SELECT sha256 FROM assets WHERE id=? AND product_id=?').get(ref.id,source.id)?.sha256===ref.sha256))return false;
  return evaluateImageRisk(result.output,settings).verdict==='PASS';
 }catch{return false;}
}
export function canResumeRiskAdaptation(db:DatabaseSync,task:import('../../shared/automatic-listing-contracts.ts').AutomaticListingTask,row:AutomaticListingItem,draft:AmazonDraft,run:ImageWorkflowRun|null,source:ProductDetail):boolean{
 if(!task.adaptation)return false;
 const saved=db.prepare("SELECT detail_json FROM audit_events WHERE action='automatic-listing.adapted' AND json_extract(detail_json,'$.token')=?").get(task.adaptation.token);if(!saved)return false;
 const proof=JSON.parse(String(saved.detail_json));if(proof.taskId!==task.id||!proof.changes.some((change:{key:string;kind:string})=>change.key===row.key&&change.kind==='RISK_RECHECK'))return false;
 const old=(proof.before as import('../../shared/automatic-listing-contracts.ts').AutomaticListingTask).items.find(item=>item.key===row.key);
 return !!old&&old.draftId===row.draftId&&old.sku===row.sku&&old.variantId===row.variantId&&old.sourceStamp===row.sourceStamp&&currentRiskRecheck(db,old,draft,run,source);
}
