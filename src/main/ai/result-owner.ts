import type { AiCall, AiResult } from '../../shared/ai-contracts.ts';

/** A local parse never changes the paid call's original terminal record. */
export function resultHasOwner(result:AiResult,call:AiCall|undefined):boolean {
  if(!call||call.id!==result.callId||call.productId!==result.productId||call.productRevision!==result.productRevision||call.providerId!==result.providerId||call.model!==result.model)return false;
  if(result.localRecovery)return call.status==='FAILED'&&call.errorCode==='OUTPUT_INVALID'&&!!call.finishedAt&&call.finishedAt<=result.createdAt&&result.createdAt===result.localRecovery.recoveredAt&&result.output.kind==='amazon-fields'&&result.listingContext?.contract==='listing-full-schema/v1';
  return call.status==='SUCCEEDED'&&call.finishedAt===result.createdAt;
}
