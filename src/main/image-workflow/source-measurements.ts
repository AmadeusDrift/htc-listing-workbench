import { sourceMeasurementSnapshot } from '../products/public.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { SourceImageMeasurement } from '../../shared/image-ai-contracts.ts';
import { getReceipt } from '../miaoshou/persistence.ts';
import { analyzeMiaoshouMeasurements, MEASUREMENT_LABELS } from '../../shared/miaoshou-measurements.ts';
import { listingFingerprint } from "../json-fingerprint.ts";
import { describesOtherObject, isDefaultMeasurement } from './image-facts.ts';

/** Read the original SKU-bound receipt, never listing defaults or AI-generated draft attributes. */
export function sourceImageMeasurements(receipt:ReturnType<typeof getReceipt>,draft:AmazonDraft,snapshotForVariant?:(variantId:string)=>NonNullable<ReturnType<typeof getReceipt>>['snapshot']):SourceImageMeasurement[]{
  if(!receipt||draft.mode==='live'&&receipt.mode==='demo')return [];
  const components=draft.salesPlan?.recipe.components,variantIds=components?.map(c=>c.variantId)??[draft.variantId];
  const unchangedPackage=!components||components.length===1&&components[0].quantity===components[0].sourcePackPieces;
  const sourceSha256=listingFingerprint({snapshot:receipt.snapshot,mapping:receipt.mapping,skuMappings:receipt.skuMappings}),rows=analyzeMiaoshouMeasurements(receipt.snapshot,receipt.mapping).skus;
  return [...new Set(variantIds)].flatMap(variantId=>{
    const key=receipt.skuMappings.find(row=>row.localVariantId===variantId)?.sourceKey,scopedRows=snapshotForVariant?analyzeMiaoshouMeasurements(snapshotForVariant(variantId),receipt.mapping).skus:rows,row=scopedRows.find(row=>row.sourceKey===key);
    return Object.values(row?.values??{}).flatMap(value=>{
      if(value.status!=='usable'||value.inferredUnit||value.value===null||describesOtherObject(value.evidence)||isDefaultMeasurement(value.evidence)||value.field.endsWith('.weight')||!value.field.startsWith('item.')&&!(unchangedPackage&&value.field.startsWith('package.')))return [];
      return [{id:'measurement:'+variantId+':'+value.field,name:MEASUREMENT_LABELS[value.field]+(variantIds.length>1?'（来源组件）':''),value:value.sourceValue+' '+value.sourceUnit,variantId,sourceSha256:snapshotForVariant?listingFingerprint({sourceSha256,snapshot:snapshotForVariant(variantId)}):sourceSha256}];
    });
  });
}
export function currentSourceImageMeasurements(db:DatabaseSync,draft:AmazonDraft){const receipt=getReceipt(db,draft.productId);return sourceImageMeasurements(receipt,draft,receipt?id=>sourceMeasurementSnapshot(db,receipt,id):undefined);}
