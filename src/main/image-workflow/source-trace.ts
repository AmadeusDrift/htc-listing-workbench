import {imageRenderDomains} from './render-domains.ts';
import type {AiCall,AiResult} from '../../shared/ai-contracts.ts';
import type {ImageWorkflowRun} from '../../shared/image-workflow-contracts.ts';
/** Read-only provenance. Model uncertainty cannot erase actual sent reference identities. */
export function imageSourceTrace(run:ImageWorkflowRun,getResult:(id:string)=>AiResult|undefined,getCall:(id:string)=>AiCall|undefined){
 const id=run.setPlanResultId??run.planResultIds.at(-1)??run.rejection?.resultId??undefined,result=id?getResult(id):undefined,call=result?getCall(result.callId):run.rejection?getCall(run.rejection.callId):undefined;
 const context=result?.imageContext??run.imageContext;
 return{selectedSku:{sku:run.sku,variantId:run.variantId,sourceVariantIds:context?.sourceVariantIds??[run.variantId],specification:context?.listing.sourceProduct?.selectedSku??null},
   referenceAssets:context?.referenceAssets??run.referenceAssets.map(ref=>({assetId:ref.id,sha256:ref.sha256,variantId:null})),
   transport:result?.imageRequestBytes?'sent':call?'attempted':'not_recorded',requestBytes:result?.imageRequestBytes??null,callId:call?.id??null,resultId:result?.id??null,providerReceiptId:call?.providerReceiptId??null,
   renderDomains:result?.output.kind==='image-plan'?imageRenderDomains(result.output,context):null,
   modelObservation:result?.output.kind==='image-plan'?result.output.productUnderstanding??null:null};
}
