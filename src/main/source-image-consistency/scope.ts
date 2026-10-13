export {validateConsistencyContext,consistencyScopeKey,consistencyDecisionKey} from './contracts.ts';
import {validateConsistencyContext} from './contracts.ts';
import { isProductReference } from "../source-reference-query.ts";
import type { DatabaseSync } from 'node:sqlite';
import { SOURCE_OBSERVATION_VERSION } from '../../shared/source-image-consistency-contracts.ts';
import type { SourceClaimField, SourceConsistencyContext, SourceConsistencyIdentity } from '../../shared/source-image-consistency-contracts.ts';
import type { WorkspaceStore } from '../store.ts';
import { listingFingerprint } from "../json-fingerprint.ts";
import { uuid } from "../ai/primitives.ts";
import { AiError } from '../ai/errors.ts';
import { readSourceImageReceipt,sourceImageMappings,allowSourceUnbound } from '../source-images.ts';
import { validateSourceImageProvenance,assertSourceImageProvenance } from '../source-image-provenance.ts';
import { readManagedImageSync } from '../ai/source.ts';
import { selectImageReferences } from "../assets/reference-selection.ts";
import { projectSourceClaims } from './comparison.ts';
import { SourceConsistencyError } from './errors.ts';

export function resolveConsistencyContext(db:DatabaseSync,store:Pick<WorkspaceStore,'getProduct'|'getAssetRecord'>,directory:string,input:{productId:string;productRevision:number;variantId:string}):SourceConsistencyContext {
  const product=store.getProduct(uuid(input.productId)),variant=product.variants.find(v=>v.id===uuid(input.variantId));
  if(product.revision!==input.productRevision||db.prepare('SELECT revision FROM products WHERE id=?').get(product.id)?.revision!==product.revision||!variant)throw new AiError('SOURCE_CHANGED');
  const source=readSourceImageReceipt(db,product.id),mapping=source?sourceImageMappings(source).find(m=>m.localVariantId===variant.id):undefined;
  if(source&&!mapping)throw new AiError('SOURCE_CHANGED');
  const fields:SourceClaimField[]=[];
  const identity:SourceConsistencyIdentity=source?{kind:source.kind,receiptId:source.receipt.id,receiptFingerprint:source.receipt.fingerprint,sourceSku:mapping!.sourceSku}:{kind:'local-original'};
  if(source?.kind==='native1688'){
    const raw=source.receipt.snapshot.skus.find(s=>s.providerSkuId===mapping!.sourceSku);if(!raw)throw new AiError('SOURCE_CHANGED');
    fields.push({id:'receipt.originalSpec',name:'spec',value:raw.originalSpec},...raw.attributes.map((a,i)=>({id:`receipt.attributes.${i}`,name:a.name,value:a.value})));
  }else if(source?.kind==='miaoshou'){
    const raw=source.receipt.mapping.skus.find(s=>s.sourceKey===mapping!.sourceSku);if(!raw)throw new AiError('SOURCE_CHANGED');
    for(const d of source.receipt.snapshot.dimensions){const value=d.values.find(v=>v.id===raw.dimensions[d.id]);if(value)fields.push({id:`receipt.dimensions.${d.id}`,name:d.name,value:value.name});}
  }
  fields.push({id:'variant.sourceSpec',name:'spec',value:variant.sourceSpec},{id:'variant.originalSpec',name:'spec',value:variant.originalSpec},{id:'variant.normalizedSpec',name:'spec',value:variant.normalizedSpec});
  const generated=new Set(db.prepare("SELECT json_extract(record_json,'$.approvedAssetId') AS id FROM image_workflow_runs WHERE json_extract(record_json,'$.productId')=? UNION SELECT json_extract(s.value,'$.approvedAssetId') AS id FROM image_workflow_runs w,json_each(w.record_json,'$.slots') s WHERE json_extract(w.record_json,'$.productId')=?").all(product.id,product.id).map(r=>String(r.id)));
  const confirmed=(assetId:string,variantId:string)=>{const binding=db.prepare('SELECT confirmed FROM variant_assets WHERE asset_id=? AND variant_id=?').get(assetId,variantId);return binding?.confirmed===1||!!source&&!!binding;};
  const allowUnbound=allowSourceUnbound(product,source);
  const anchors=new Map<string,ReturnType<typeof validateSourceImageProvenance>>();
  // Establish exact eligible supplier originals before generic count/byte/role ordering.
  // Invalid anchored identity or bytes are errors, never reasons to use a local fallback.
  if(source)for(const ref of product.assets){
    if(generated.has(ref.id)||!(ref.variantIds.includes(variant.id)?confirmed(ref.id,variant.id):allowUnbound&&product.variants.length===1&&ref.variantIds.length===0))continue;
    const candidates=db.prepare("SELECT record_json FROM source_image_provenance WHERE json_extract(record_json,'$.assetId')=? ORDER BY rowid").all(ref.id).map(r=>validateSourceImageProvenance(JSON.parse(String(r.record_json))));
    const allowed=[...mapping!.images].sort((a,b)=>Number(a.basis!=='provider-sku-id')-Number(b.basis!=='provider-sku-id'));
    for(const candidate of candidates)assertSourceImageProvenance(db,candidate,directory);
    const anchor=allowed.flatMap(i=>candidates.filter(a=>a.receiptKind===source.kind&&a.receiptId===source.receipt.id&&a.imageId===i.imageId&&a.mappings.some(m=>m.localVariantId===variant.id&&m.sourceSku===mapping!.sourceSku)))[0];
    if(anchor)anchors.set(ref.id,anchor);
  }
  const preferred=anchors.size?{...product,assets:product.assets.filter(a=>anchors.has(a.id))}:product;
  const refs=selectImageReferences(preferred,variant.id,generated,confirmed,allowUnbound,[variant.id],10);
  const referenceAssets=refs.map(ref=>{
    const asset=store.getAssetRecord(ref.id);if(!asset||asset.productId!==product.id)throw new AiError('SOURCE_CHANGED');readManagedImageSync(directory,asset);
    let anchorId:string|null=null,imageId:string|null=null;
    if(source){
      const anchor=anchors.get(asset.id);
      if(anchor){anchorId=anchor.id;imageId=anchor.imageId;}else if(!confirmed(asset.id,variant.id))throw new SourceConsistencyError('NEEDS_INPUT','SOURCE_CONSISTENCY_BINDING_REQUIRED','该 SKU 的原图尚无已确认的对应关系，请在商品图片中核对并确认原图对应规格，再继续来源一致性校验');
    }
    const epoch=db.prepare("SELECT id FROM source_consistency_bindings WHERE json_extract(record_json,'$.productId')=? AND json_extract(record_json,'$.variantId')=? AND json_extract(record_json,'$.assetId')=? ORDER BY rowid DESC LIMIT 1").get(product.id,variant.id,asset.id);
    const binding=db.prepare('SELECT * FROM variant_assets WHERE asset_id=? AND variant_id=?').get(asset.id,variant.id);
    if(epoch&&!binding)throw new AiError('SOURCE_CHANGED');
    return{...(isProductReference(db,product.id,variant.id,asset.id)?{scope:'product' as const}:{}),source:anchorId?'receipt-image' as const:'local-original' as const,assetId:asset.id,sha256:asset.sha256,byteSize:asset.byteSize,anchorId,imageId,bindingEpoch:listingFingerprint({epoch:epoch?.id??null,binding:binding??null,role:ref.role})};
  });
  return validateConsistencyContext({version:SOURCE_OBSERVATION_VERSION,productId:product.id,productRevision:product.revision,variantId:variant.id,identity,referenceAssets:referenceAssets.some(a=>a.source==='receipt-image')?referenceAssets.filter(a=>a.source==='receipt-image'):referenceAssets,...projectSourceClaims(fields)});
}
