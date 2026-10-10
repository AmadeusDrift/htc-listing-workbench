import type { AiCall,AiResult } from '../../shared/ai-contracts.ts';
import { AiError } from './errors.ts';
export function assertPresentationResultOwner(result:AiResult,call:AiCall|undefined):void{
 if(!result.fieldRejections&&!call?.presentationContext)return;
 const context=result.listingContext??result.imageContext?.listing,p=call?.presentationContext;
 if(!call||!p||!context||call.id!==result.callId||call.status!=='SUCCEEDED'||call.productId!==result.productId||call.productRevision!==result.productRevision||call.providerId!==result.providerId||call.model!==result.model||call.finishedAt!==result.createdAt||p.draftId!==context.draftId||p.variantId!==result.variantId||p.sourceSha256!==result.sourceSha256||p.kind!==(result.imageContext?'image':'listing')||p.slot!==(result.imageContext?.slot?.index??0))throw new AiError('INVALID_CONFIG');
}
