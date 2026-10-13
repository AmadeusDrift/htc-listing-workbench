import { assertPartialSourceReuse } from './adaptation.ts';
import { resultHasOwner } from '../ai/result-owner.ts';
import { evaluateImageRisk } from '../../shared/image-risk-policy.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { AiCall, AiResult } from '../../shared/ai-contracts.ts';
import { PRODUCT_IMAGE_POLICY_VERSION, imageCopySourceIds } from '../../shared/image-ai-contracts.ts';
import type { ProductImageContext } from '../../shared/image-ai-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { listingFingerprint } from "../json-fingerprint.ts";
import { assertCurrentListingReview, assertImagePlan, assertImageTextReview, validateProductImageContext } from '../ai/image-validation.ts';
import { workflowRuns } from './records.ts';
import { referenceMeasurementEvidence } from './image-facts.ts';
import { assertApprovalReuseSource } from './approval-reuse.ts';

/** Validate historical evidence, not current draft revisions: source edits and retention may follow adoption. */
export function assertImageWorkflowHistory(db: DatabaseSync, results: Map<string,AiResult>, calls: Map<string,AiCall>, draftId?:string): void {
  const invalid=():never=>{throw new UserFacingError('自动图片流程的生成、OCR 或复核记录关联不完整');};
  const successful=(id:string):AiResult=>{
    const result=results.get(id),call=result&&calls.get(result.callId);
    if(!result||!call||!resultHasOwner(result,call))return invalid();
    return result;
  };
  const assertCopySource=(context:ProductImageContext,copyReviewEnabled:boolean|undefined,version?:string):void=>{
    validateProductImageContext(context,{storedVersion:version??null});
    if(context.copyReviewBypass){if(copyReviewEnabled!==false)invalid();return;}
    if(context.listingReviewResultId===null)return invalid();
    const copy=successful(context.listingReviewResultId);
    if(copy.output.kind!=='listing-current-review'||copy.output.verdict!=='PASS'||!copy.listingContext||listingFingerprint(copy.listingContext)!==listingFingerprint(context.listing)||listingFingerprint(copy.output.currentListingCopy)!==listingFingerprint(context.currentListingCopy))return invalid();
    assertCurrentListingReview({...copy.output,kind:'amazon-fields-review'},context.currentListingCopy,context.listing,{storedVersion:copy.listingEvidenceContractVersion??null});
  };
  const runs=workflowRuns(db,draftId), byId=new Map(runs.map(run=>[run.id,run]));
  for(const run of runs) {
    if(run.approvalReuse){assertApprovalReuseSource(run,byId.get(run.approvalReuse.sourceRunId));continue;}
    if(run.slots){
      const source=run.sourceReuse?byId.get(run.sourceReuse.sourceRunId):undefined;if(run.sourceReuse)assertPartialSourceReuse(run,source,db);
      const prior=run.recheckedFromRunId?byId.get(run.recheckedFromRunId):undefined;
      if(run.recheckedFromRunId){
        const seen=new Set([run.id]);let cursor=prior;while(cursor){if(seen.has(cursor.id))invalid();seen.add(cursor.id);cursor=cursor.recheckedFromRunId?byId.get(cursor.recheckedFromRunId):undefined;}
        if(!prior?.slots||prior.status!=='COMPLETED'||prior.productId!==run.productId||prior.productRevision!==run.productRevision||prior.variantId!==run.variantId||prior.draftId!==run.draftId||prior.sku!==run.sku||prior.imagePolicyVersion!==run.imagePolicyVersion||run.maxAttempts!==1||prior.createdAt>run.createdAt||run.referenceAssets.length&&listingFingerprint(prior.referenceAssets)!==listingFingerprint(run.referenceAssets))invalid();
      }
      for(const ref of run.referenceAssets){const asset=db.prepare('SELECT product_id,sha256 FROM assets WHERE id=?').get(ref.id);if(!asset||asset.product_id!==run.productId||asset.sha256!==ref.sha256)invalid();}
      for(const measurement of run.imageContext?.referenceMeasurements??[]){
        const ocr=successful(measurement.ocrResultId),ref=run.referenceAssets.find(ref=>ref.id===measurement.assetId);
        if(!ref||ocr.output.kind!=='ocr'||ocr.productId!==run.productId||ocr.productRevision!==run.productRevision||ocr.assetId!==ref.id||ocr.assetSha256!==ref.sha256||!referenceMeasurementEvidence(ocr).some(item=>listingFingerprint(item)===listingFingerprint(measurement)))invalid();
      }
      if(run.setPlanResultId){
        const set=successful(run.setPlanResultId);
        if(set.output.kind!=='image-plan'||!set.imageContext||set.imageContext.slot||set.productId!==run.productId||set.productRevision!==(source??run).productRevision||set.variantId!==run.variantId||listingFingerprint(set.output.setPlan)!==listingFingerprint(run.setPlan)||listingFingerprint(set.sourceResultIds)!==listingFingerprint(imageCopySourceIds(set.imageContext)))invalid();
        if(prior){if(run.setPlanResultId!==prior.setPlanResultId||listingFingerprint(run.setPlan)!==listingFingerprint(prior.setPlan))invalid();}
        else {
          if(listingFingerprint(set.imageContext)!==listingFingerprint((source??run).imageContext))invalid();
          assertCopySource(set.imageContext!,run.copyReviewEnabled,set.listingEvidenceContractVersion);
        }
        if(set.output.kind==='image-plan')assertImagePlan(set.output,set.imageContext!,{storedVersion:set.listingEvidenceContractVersion??null});
        if(run.slots.some(slot=>slot.attempts.length)&&(set.output.kind!=='image-plan'||!set.output.productUnderstanding?.sufficient||run.riskInterceptionEnabled!==false&&set.output.ipRisk?.verdict!=='PASS'))invalid();
      }
      for(const slot of run.slots){
        let historical=false;
        const owned=(id:string,kind:AiResult['output']['kind'])=>{
          const result=successful(id),context=result.imageContext;
          if(result.output.kind!==kind||!context||context.policyVersion!==run.imagePolicyVersion||result.productId!==run.productId||result.productRevision!==(historical?source!:run).productRevision||result.variantId!==run.variantId||result.sourceSha256!==(historical?source!.slots![slot.index-1].contextSha256:slot.contextSha256)||listingFingerprint(context)!==(historical?source!.slots![slot.index-1].contextSha256:slot.contextSha256)||context.listing.draftId!==run.draftId||context.listing.sku!==run.sku||context.slot?.index!==slot.index||context.purpose!==slot.purpose||listingFingerprint(context.referenceAssets.map(ref=>({id:ref.assetId,sha256:ref.sha256})))!==listingFingerprint(run.referenceAssets))return invalid();
          assertCopySource(context,run.copyReviewEnabled,result.listingEvidenceContractVersion);return result;
        };
        for(const [index,attempt] of slot.attempts.entries()){
          historical=!!source&&index<run.sourceReuse!.slotAttempts[slot.index-1];
          const plan=attempt.planResultId?owned(attempt.planResultId,'image-plan'):undefined;
          if(plan){
            if(plan.output.kind!=='image-plan')invalid();else assertImagePlan(plan.output,plan.imageContext!,{storedVersion:plan.listingEvidenceContractVersion??null});
            const previous=source&&index===run.sourceReuse!.slotAttempts[slot.index-1]?undefined:slot.attempts[index-1],expected=[...imageCopySourceIds(plan.imageContext!),...(previous?.planResultId?[previous.planResultId]:[])];
            if(listingFingerprint(plan.sourceResultIds)!==listingFingerprint(expected)||attempt.candidateId&&(plan.output.kind!=='image-plan'||!plan.output.productUnderstanding?.sufficient||run.riskInterceptionEnabled!==false&&plan.output.ipRisk?.verdict!=='PASS'))invalid();
          }
          const ip=attempt.ipReviewResultId?owned(attempt.ipReviewResultId,'image-ip-review'):undefined;
          if(ip&&(ip.output.kind!=='image-ip-review'||ip.output.candidate.id!==attempt.candidateId||ip.output.planResultId!==plan?.id||listingFingerprint(ip.sourceResultIds)!==listingFingerprint([...imageCopySourceIds(ip.imageContext!),plan?.id])))invalid();
          const ocr=attempt.ocrResultId?owned(attempt.ocrResultId,'generated-image-ocr'):undefined;
          if(ocr&&(ocr.output.kind!=='generated-image-ocr'||ocr.output.candidate.id!==attempt.candidateId||listingFingerprint(ocr.sourceResultIds)!==listingFingerprint(imageCopySourceIds(ocr.imageContext!))))invalid();
          if(ocr?.output.kind==='generated-image-ocr'){
            if(attempt.riskBypass){if(run.riskInterceptionEnabled!==false||listingFingerprint(attempt.riskBypass.candidate)!==listingFingerprint(ocr.output.candidate))invalid();}
            else if(ip?.output.kind!=='image-ip-review'||(attempt.riskPolicy?evaluateImageRisk(ip.output,attempt.riskPolicy).verdict!=='PASS':ip.output.verdict!=='PASS')||listingFingerprint(ip.output.candidate)!==listingFingerprint(ocr.output.candidate))invalid();
          }
          const review=attempt.reviewResultId?owned(attempt.reviewResultId,'image-text-review'):undefined;
          if(review){
            if(review.output.kind!=='image-text-review'||!plan||ocr?.output.kind!=='generated-image-ocr'||review.output.candidate.id!==attempt.candidateId||listingFingerprint(review.sourceResultIds)!==listingFingerprint([...imageCopySourceIds(review.imageContext!),plan.id,ocr.id]))invalid();
            else assertImageTextReview(review.output,review.imageContext!,plan,ocr,ocr.output.candidate,{storedVersion:review.listingEvidenceContractVersion??null});
            if(attempt.state==='PASSED'&&!attempt.approvalPolicy&&review.output.kind==='image-text-review'&&review.output.verdict!=='PASS'||index<slot.attempts.length-1&&review.output.kind==='image-text-review'&&review.output.verdict==='PASS')invalid();
          }
          if(prior&&attempt.candidateId!==null&&attempt.candidateId!==prior.slots![slot.index-1].attempts.at(-1)?.candidateId)invalid();
        }
        if(slot.status==='PASSED'){
          const last=slot.attempts.at(-1)!,bypassed=last.approvalPolicy==='risk-disabled-detail/v1',review=bypassed?undefined:successful(last.approvalPolicy?last.ipReviewResultId!:last.reviewResultId!),asset=db.prepare('SELECT product_id,sha256,width,height FROM assets WHERE id=?').get(slot.approvedAssetId!);
          if(bypassed&&(!last.riskBypass||run.riskInterceptionEnabled!==false||slot.index===1))invalid();
          if(!bypassed&&(!review||review.output.kind!==(last.approvalPolicy?'image-ip-review':'image-text-review')||!('candidate' in review.output)||!('verdict' in review.output)||(review.output.kind==='image-ip-review'&&last.riskPolicy?evaluateImageRisk(review.output,last.riskPolicy).verdict!=='PASS':review.output.verdict!=='PASS')))invalid();
          const identity=bypassed?last.riskBypass!.candidate:review&&'candidate' in review.output?review.output.candidate:undefined;
          if(!identity||identity.id!==last.candidateId||identity.sha256!==slot.approvedSha256||!asset||asset.product_id!==run.productId||asset.sha256!==slot.approvedSha256||asset.width!==identity.width||asset.height!==identity.height||!db.prepare('SELECT 1 FROM variant_assets WHERE asset_id=? AND variant_id=? AND confirmed=1').get(slot.approvedAssetId!,run.variantId)||prior&&(slot.approvedAssetId!==prior.slots![slot.index-1].approvedAssetId||slot.approvedSha256!==prior.slots![slot.index-1].approvedSha256))invalid();
        }
      }
      continue;
    }
    if(run.recheckedFromRunId){
      const prior=byId.get(run.recheckedFromRunId), seen=new Set([run.id]); let cursor=prior;
      while(cursor){if(seen.has(cursor.id))invalid();seen.add(cursor.id);cursor=cursor.recheckedFromRunId?byId.get(cursor.recheckedFromRunId):undefined;}
      if(!prior||prior.status!=='COMPLETED'||prior.productId!==run.productId||prior.productRevision!==run.productRevision||prior.variantId!==run.variantId||prior.draftId!==run.draftId||prior.sku!==run.sku
        ||prior.imagePolicyVersion!==run.imagePolicyVersion||Date.parse(prior.createdAt)>Date.parse(run.createdAt)||run.maxAttempts!==1
        ||run.referenceAssets.length&&listingFingerprint(prior.referenceAssets)!==listingFingerprint(run.referenceAssets)
        ||run.candidateIds.some(id=>id!==prior.candidateIds.at(-1))||run.status==='COMPLETED'&&(run.approvedAssetId!==prior.approvedAssetId||run.approvedSha256!==prior.approvedSha256))invalid();
    }
    for(const ref of run.referenceAssets) {
      const asset=db.prepare('SELECT product_id,sha256 FROM assets WHERE id=?').get(ref.id);
      if(!asset||asset.product_id!==run.productId||asset.sha256!==ref.sha256)invalid();
    }
    const owned=(id:string,kind:AiResult['output']['kind'])=>{
      const result=successful(id),context=result.imageContext;
      if(run.imagePolicyVersion && context?.policyVersion!==run.imagePolicyVersion)return invalid();
      if(context?.policyVersion===PRODUCT_IMAGE_POLICY_VERSION && run.imagePolicyVersion!==PRODUCT_IMAGE_POLICY_VERSION)return invalid();
      if(result.output.kind!==kind||result.productId!==run.productId||result.productRevision!==run.productRevision||result.variantId!==run.variantId||!context||result.sourceSha256!==run.contextSha256||listingFingerprint(context)!==run.contextSha256||context.listing.draftId!==run.draftId||context.listing.sku!==run.sku||
        listingFingerprint(context.referenceAssets.map(ref=>({id:ref.assetId,sha256:ref.sha256})))!==listingFingerprint(run.referenceAssets))return invalid();
      assertCopySource(context,run.copyReviewEnabled,result.listingEvidenceContractVersion);
      return result;
    };
    for(const [index,id] of run.planResultIds.entries()) {
      const plan=owned(id,'image-plan'); if(plan.output.kind!=='image-plan')return invalid();
      assertImagePlan(plan.output,plan.imageContext!,{storedVersion:plan.listingEvidenceContractVersion??null});
      if(plan.imageContext!.policyVersion!=='product-image/v1' && index<run.candidateIds.length && !plan.output.productUnderstanding?.sufficient)invalid();
      if(plan.imageContext!.policyVersion===PRODUCT_IMAGE_POLICY_VERSION && index<run.candidateIds.length && plan.output.ipRisk?.verdict!=='PASS')invalid();
      const expected=[...imageCopySourceIds(plan.imageContext!),...(index?[run.planResultIds[index-1]]:[])];
      if(listingFingerprint(plan.sourceResultIds)!==listingFingerprint(expected))invalid();
    }
    for(const [index,id] of (run.ipReviewResultIds??[]).entries()) {
      const ip=owned(id,'image-ip-review'), plan=successful(run.planResultIds[index]);
      if(ip.output.kind!=='image-ip-review'||ip.output.candidate.id!==run.candidateIds[index]||ip.output.planResultId!==plan.id||plan.output.kind!=='image-plan'||plan.output.ipRisk?.verdict!=='PASS'||listingFingerprint(ip.sourceResultIds)!==listingFingerprint([...imageCopySourceIds(ip.imageContext!),plan.id]))invalid();
    }
    for(const [index,id] of run.ocrResultIds.entries()) {
      const ocr=owned(id,'generated-image-ocr');
      if(ocr.output.kind!=='generated-image-ocr'||ocr.output.candidate.id!==run.candidateIds[index]||listingFingerprint(ocr.sourceResultIds)!==listingFingerprint(imageCopySourceIds(ocr.imageContext!)))invalid();
      if(run.imagePolicyVersion===PRODUCT_IMAGE_POLICY_VERSION) {
        const ip=successful(run.ipReviewResultIds![index]);
        if(ip.output.kind!=='image-ip-review'||(run.riskPolicy?evaluateImageRisk(ip.output,run.riskPolicy).verdict!=='PASS':ip.output.verdict!=='PASS')||ocr.output.kind!=='generated-image-ocr'||listingFingerprint(ip.output.candidate)!==listingFingerprint(ocr.output.candidate))invalid();
      }
    }
    for(const [index,id] of run.reviewResultIds.entries()) {
      const review=owned(id,'image-text-review'),plan=successful(run.planResultIds[index]),ocr=successful(run.ocrResultIds[index]);
      if(review.output.kind!=='image-text-review'||ocr.output.kind!=='generated-image-ocr'||review.output.candidate.id!==run.candidateIds[index]||review.output.planResultId!==plan.id||review.output.ocrResultId!==ocr.id||listingFingerprint(review.sourceResultIds)!==listingFingerprint([...imageCopySourceIds(review.imageContext!),plan.id,ocr.id]))return invalid();
      assertImageTextReview(review.output,review.imageContext!,plan,ocr,ocr.output.candidate,{storedVersion:review.listingEvidenceContractVersion??null});
      if(index<run.reviewResultIds.length-1&&review.output.verdict!=='NEEDS_CHANGES')invalid();
    }
    if(run.status==='COMPLETED') {
      const review=successful(run.reviewResultIds.at(-1)!),asset=db.prepare('SELECT product_id,sha256,width,height FROM assets WHERE id=?').get(run.approvedAssetId!);
      if(review.output.kind!=='image-text-review'||review.output.verdict!=='PASS'||review.output.candidate.sha256!==run.approvedSha256||!asset||asset.product_id!==run.productId||asset.sha256!==run.approvedSha256||asset.width!==review.output.candidate.width||asset.height!==review.output.candidate.height)invalid();
    }
  }
}
