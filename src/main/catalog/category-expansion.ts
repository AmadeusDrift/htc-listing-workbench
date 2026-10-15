import type {AiService} from '../ai/service.ts';
import type {AmazonService} from '../amazon/service.ts';
import type {ClassificationDependencies,ClassificationInput} from './classification.ts';
import {AiError} from '../ai/errors.ts';
import {taskAiContext} from '../ai/batch/task-context.ts';

/** One production main-only composition, also used by the isolated real-service factory. */
export function categoryExpansionPort(input:ClassificationInput,ai:Pick<AiService,'reserveCategoryCandidateExpansion'|'permitCategoryCandidateExpansion'|'retainCategoryCandidateExpansion'|'captureCategoryCandidateExpansionReceipt'|'readCategoryCandidateExpansionReceipt'>,amazon:Pick<AmazonService,'searchProductTypesObserved'|'executionTargetScope'>,fresh:()=>void):NonNullable<ClassificationDependencies['expansion']>{
 const scope=()=>{const {target}=amazon.executionTargetScope(input.targetId);return {targetId:target.id,sellerId:target.sellerId,marketplaceId:target.marketplaceId,region:target.region,locale:target.locale,mode:target.mode};};
 const read=(requestId:string)=>ai.readCategoryCandidateExpansionReceipt({productId:input.productId,requestId,targetScope:scope()});
 const dispatchGrant=()=>{const grant=taskAiContext.getStore();if(!grant||!grant.rowKey.startsWith(input.productId+':')||!grant.authorize()){const error=new AiError('CANCELLED');error.certainty='NOT_SENT';error.diagnosticReason='CATEGORY_CONTINUATION_NOT_AUTHORIZED';throw error;}};
 return {
  reserve:value=>{fresh();return ai.reserveCategoryCandidateExpansion(value);},
  permit:value=>{fresh();return ai.permitCategoryCandidateExpansion(value);},
  retain:(productId,snapshot)=>ai.retainCategoryCandidateExpansion(productId,snapshot),
  read:claim=>{fresh();return read(claim.requestId);},
  search:async(claim,permit)=>{
   fresh();dispatchGrant();let dispatched=false;
   try{await amazon.searchProductTypesObserved({targetId:claim.targetId,keywords:claim.query,requestId:claim.requestId},()=>{fresh();permit();dispatched=true;},capture=>ai.captureCategoryCandidateExpansionReceipt(input.productId,capture));}
   catch(cause){if(dispatched&&!read(claim.requestId)){const error=new AiError('INTERRUPTED');error.certainty='SENT_UNKNOWN';error.requestId=claim.requestId;error.diagnosticReason='CATEGORY_EXPANSION_RESULT_UNKNOWN';error.message='类目扩展已许可发送，原始完整回执不可用；本次未重发';throw error;}throw cause;}
   fresh();const receipt=read(claim.requestId);if(!receipt)throw Error('Original category lookup receipt missing after capture');return receipt;
  },
 };
}
