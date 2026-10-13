import { SOURCE_COLOR_POLICY_VERSION, SOURCE_COLOR_VALUES } from '../../shared/source-color-contracts.ts';
import type { SourceColorContext, SourceColorOutput, SourceColorValue } from '../../shared/source-color-contracts.ts';
import type { AiCall, AiResult } from '../../shared/ai-contracts.ts';
import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { UserFacingError } from '../../shared/errors.ts';
import { AiError } from './errors.ts';
import { boundedText, integer, keys, sha256, uuid, uuidList } from "./primitives.ts";

export function validateSourceColorContext(raw: unknown): SourceColorContext {
  try {
    const value=keys(raw,['policyVersion','productId','productRevision','variantId','sourceSpec','referenceAssets']);
    if(value.policyVersion!==SOURCE_COLOR_POLICY_VERSION||!Array.isArray(value.referenceAssets)||!value.referenceAssets.length||value.referenceAssets.length>10)throw new Error();
    const referenceAssets=value.referenceAssets.map(raw=>{const ref=keys(raw,['assetId','sha256']);return{assetId:uuid(ref.assetId),sha256:sha256(ref.sha256)};});
    if(new Set(referenceAssets.map(ref=>ref.assetId)).size!==referenceAssets.length)throw new Error();
    const sourceSpec=boundedText(value.sourceSpec,4000,true);if(sourceSpec!==sourceSpec.trim())throw new Error();
    return {policyVersion:SOURCE_COLOR_POLICY_VERSION,productId:uuid(value.productId),productRevision:integer(value.productRevision,1,Number.MAX_SAFE_INTEGER),variantId:uuid(value.variantId),sourceSpec,referenceAssets};
  } catch { throw new AiError('INVALID_INPUT'); }
}

export function validateSourceColorOutput(raw: unknown): SourceColorOutput {
  try {
    const value=keys(raw,['kind','verdict','colors','reason','referenceAssetIds']);
    if(value.kind!=='source-color'||typeof value.verdict!=='string'||!['DETERMINED','UNCERTAIN','CONFLICTING'].includes(value.verdict)||!Array.isArray(value.colors)||value.colors.length>SOURCE_COLOR_VALUES.length)throw new Error();
    const colors=value.colors.map(color=>{if(typeof color!=='string'||!SOURCE_COLOR_VALUES.includes(color as SourceColorValue))throw new Error();return color as SourceColorValue;});
    if(new Set(colors).size!==colors.length||colors.includes('Multicolor')&&colors.length!==1||(value.verdict==='DETERMINED'?colors.length===0:colors.length!==0))throw new Error();
    const referenceAssetIds=uuidList(value.referenceAssetIds,10,1);
    return {kind:'source-color',verdict:value.verdict as SourceColorOutput['verdict'],colors,reason:boundedText(value.reason,1000),referenceAssetIds};
  } catch { throw new AiError('OUTPUT_INVALID'); }
}

export function assertSourceColorOutput(output: SourceColorOutput, context: SourceColorContext): void {
  if(output.referenceAssetIds.length!==context.referenceAssets.length||output.referenceAssetIds.some((id,index)=>id!==context.referenceAssets[index].assetId))throw new AiError('OUTPUT_INVALID');
}

/** Historical snapshots remain valid after source edits; their calls and original image bytes must remain authentic. */
export function assertSourceColorHistory(db:DatabaseSync,results:Map<string,AiResult>,calls:Map<string,AiCall>):{relativePath:string;sha256:string;byteSize:number}[] {
  const observations=[...results.values()].filter(result=>result.output.kind==='source-color');
  const invalid=():never=>{throw new UserFacingError('来源颜色观察的调用记录或原始图片关联不完整');};
  const generated=new Set(observations.length?db.prepare("SELECT json_extract(record_json,'$.approvedAssetId') AS assetId FROM image_workflow_runs UNION SELECT json_extract(s.value,'$.approvedAssetId') AS assetId FROM image_workflow_runs w, json_each(w.record_json,'$.slots') s").all().map(row=>String(row.assetId)):[]);
  const artifacts=new Map<string,{relativePath:string;sha256:string;byteSize:number}>();
  for(const result of observations){
    const call=calls.get(result.callId),context=result.sourceColorContext;
    if(!context||!call||call.status!=='SUCCEEDED'||call.productId!==result.productId||call.productRevision!==result.productRevision||call.providerId!==result.providerId||call.model!==result.model||call.finishedAt!==result.createdAt)invalid();
    const variant=db.prepare('SELECT product_id FROM variants WHERE id=?').get(context!.variantId);
    if(variant&&variant.product_id!==result.productId)invalid();
    for(const reference of context!.referenceAssets){
      const asset=db.prepare('SELECT product_id,sha256,original_path,byte_size FROM assets WHERE id=?').get(reference.assetId);
      if(!asset||asset.product_id!==result.productId||asset.sha256!==reference.sha256||generated.has(reference.assetId))invalid();
      artifacts.set(reference.assetId,{relativePath:String(asset!.original_path),sha256:reference.sha256,byteSize:Number(asset!.byte_size)});
    }
  }
  const drafts=new Map<string,AmazonDraft>();
  for(const result of results.values()){
    const attempt=calls.get(result.callId)?.sourceColorContext;
    if(attempt&&(result.output.kind!=='source-color'||!isDeepStrictEqual(attempt,result.sourceColorContext)))invalid();
    for(const listing of [result.listingContext,result.imageContext?.listing]){
      if(!listing)continue;
      for(const evidence of listing.evidence){
        if(evidence.source!=='source_image'){
          if(evidence.imageObservation!==undefined||evidence.id.includes(':source-color:'))invalid();
          continue;
        }
        const proof=evidence.imageObservation;
        const observed=proof?results.get(proof.resultId):undefined;
        if(!proof||!observed||observed.output.kind!=='source-color'||observed.output.verdict!=='DETERMINED'||!observed.sourceColorContext)return invalid();
        if(observed.id!==proof.resultId||observed.productId!==listing.productId||observed.productRevision!==listing.productRevision||
          !isDeepStrictEqual(observed.sourceColorContext,proof.context)||!isDeepStrictEqual(observed.output.colors,proof.colors)||
          evidence.meaning!=='color'||evidence.value!==proof.colors.join(', ')||evidence.id!==`${listing.variantId}:source-color:${observed.id}`)invalid();
        let draft=drafts.get(listing.draftId);
        if(!draft){
          const row=db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(listing.draftId);
          if(!row)return invalid();
          draft=JSON.parse(String(row.record_json)).draft as AmazonDraft;
          if(!draft)return invalid();
          drafts.set(listing.draftId,draft);
        }
        // A source component can differ from the sale's anchor variant, but must belong to its saved recipe.
        // Product text revisions may advance after an observation; compare revisions against the historical listing above.
        if(draft.id!==listing.draftId||draft.productId!==listing.productId||draft.variantId!==listing.variantId||draft.sku!==listing.sku||draft.targetId!==listing.targetId)invalid();
        const components=draft.salesPlan?.recipe?.components;
        if(draft.salesPlan===undefined){if(proof.context.variantId!==listing.variantId)invalid();}
        else if(!Array.isArray(components)||!components.some(component=>component.variantId===listing.variantId)||!components.some(component=>component.variantId===proof.context.variantId))invalid();
      }
    }
  }
  return [...artifacts.values()];
}
