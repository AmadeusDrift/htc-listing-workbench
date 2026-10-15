import { listingFingerprint } from "../json-fingerprint.ts";
import type { AiCall, AiResult } from '../../shared/ai-contracts.ts';

/** A local parse never changes the paid call's original terminal record. */
export function resultHasOwner(result:AiResult,call:AiCall|undefined):boolean {
  if(!call||call.id!==result.callId||call.productId!==result.productId||call.productRevision!==result.productRevision||call.providerId!==result.providerId||call.model!==result.model)return false;
  if(result.providerReceiptRecovery){const r=result.providerReceiptRecovery;return call.status==='FAILED'&&!!call.finishedAt&&call.finishedAt<=result.createdAt&&r.recoveredAt===result.createdAt&&call.requestFingerprint===r.requestFingerprint&&!!call.requestScope&&listingFingerprint(call.requestScope)===r.scopeSha256&&(r.version===1?call.providerReceiptId===r.receiptId:call.providerReceiptId===undefined&&/^[a-f0-9]{64}$/.test(r.receiptSha256));}
  if(result.fieldGroupAssembly){const original=result.fieldGroupAssembly.sources[0];return !!original&&!original.fieldGroupAssembly&&original.callId===result.callId&&original.createdAt===result.createdAt&&resultHasOwner(original,call);}
  if(result.imagePlanRecovery){
    const context=result.imageContext,p=call.presentationContext;
    return call.status==='FAILED'&&call.errorCode==='OUTPUT_INVALID'&&!!call.finishedAt&&call.finishedAt<=result.createdAt&&result.createdAt===result.imagePlanRecovery.recoveredAt&&result.output.kind==='image-plan'&&!!context&&p?.kind==='image'&&p.draftId===context.listing.draftId&&p.variantId===result.variantId&&p.slot===(context.slot?.index??0)&&p.sourceSha256===result.sourceSha256&&p.sourceSha256===result.imagePlanRecovery.contextSha256&&(!result.imagePlanRecovery.repair||!!p.imagePlanRequestSha256)&&(p.imagePlanRequestSha256===undefined||p.imagePlanRequestSha256===listingFingerprint({context,repair:result.imagePlanRecovery.repair??null}));
  }
  if(result.localRecovery)return call.status==='FAILED'&&call.errorCode==='OUTPUT_INVALID'&&!!call.finishedAt&&call.finishedAt<=result.createdAt&&result.createdAt===result.localRecovery.recoveredAt&&result.output.kind==='amazon-fields'&&result.listingContext?.contract==='listing-full-schema/v1';
  return call.status==='SUCCEEDED'&&call.finishedAt===result.createdAt;
}
