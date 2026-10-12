import { isProductReference } from '../image-upstream-trace.ts';
import type { DatabaseSync } from 'node:sqlite';
import { SOURCE_CONSISTENCY_VERSION,SOURCE_OBSERVATION_VERSION } from '../../shared/source-image-consistency-contracts.ts';
import type { SourceClaimField, SourceConsistencyContext, SourceConsistencyIdentity } from '../../shared/source-image-consistency-contracts.ts';
import type { WorkspaceStore } from '../store.ts';
import { listingFingerprint } from '../listing-ai/validation.ts';
import { boundedText,integer,keys,sha256,uuid } from '../ai/validation.ts';
import { AiError } from '../ai/errors.ts';
import { readSourceImageReceipt,sourceImageMappings,allowSourceUnbound } from '../source-images.ts';
import { validateSourceImageProvenance,assertSourceImageProvenance } from '../source-image-provenance.ts';
import { readManagedImageSync } from '../ai/source.ts';
import { selectImageReferences } from '../image-workflow/records.ts';
import { projectSourceClaims } from './comparison.ts';
import { SourceConsistencyError } from './errors.ts';

export function validateConsistencyContext(raw:unknown):SourceConsistencyContext {
  const o=keys(raw,['version','productId','productRevision','variantId','identity','referenceAssets','fields','claims','issues']);
  if(![SOURCE_CONSISTENCY_VERSION,SOURCE_OBSERVATION_VERSION].includes(o.version as never)||!Array.isArray(o.fields)||o.fields.length>205||!Array.isArray(o.referenceAssets)||!o.referenceAssets.length||o.referenceAssets.length>10)throw new AiError('INVALID_INPUT');
  const identityRaw=o.identity as Record<string,unknown>;
  const s=keys(identityRaw,identityRaw?.kind==='local-original'?['kind']:['kind','receiptId','receiptFingerprint','sourceSku']);
  let identity:SourceConsistencyIdentity;
  if(s.kind==='local-original')identity={kind:'local-original'};
  else if(s.kind==='native1688'||s.kind==='miaoshou')identity={kind:s.kind,receiptId:uuid(s.receiptId),receiptFingerprint:sha256(s.receiptFingerprint),sourceSku:boundedText(s.sourceSku,256)};
  else throw new AiError('INVALID_INPUT');
  const fields=o.fields.map(raw=>{const f=keys(raw,['id','name','value']);return{id:boundedText(f.id,150),name:boundedText(f.name,200,true),value:boundedText(f.value,4000,true)};});
  if(new Set(fields.map(f=>f.id)).size!==fields.length)throw new AiError('INVALID_INPUT');
  const projection=projectSourceClaims(fields);
  if(listingFingerprint(o.claims)!==listingFingerprint(projection.claims)||listingFingerprint(o.issues)!==listingFingerprint(projection.issues))throw new AiError('INVALID_INPUT');
  const referenceAssets=o.referenceAssets.map(raw=>{const a=keys(raw,['source','assetId','sha256','byteSize','bindingEpoch','anchorId','imageId'],['scope']);if(a.scope!==undefined&&a.scope!=='product')throw new AiError('INVALID_INPUT');if(!['local-original','receipt-image'].includes(String(a.source))||(a.source==='local-original')!==(a.anchorId===null&&a.imageId===null)||a.source==='receipt-image'&&identity.kind==='local-original')throw new AiError('INVALID_INPUT');return{...(a.scope==='product'?{scope:'product' as const}:{}),source:a.source as 'local-original'|'receipt-image',assetId:uuid(a.assetId),sha256:sha256(a.sha256),byteSize:integer(a.byteSize,1,20*1024*1024),bindingEpoch:sha256(a.bindingEpoch),anchorId:a.anchorId===null?null:uuid(a.anchorId),imageId:a.imageId===null?null:boundedText(a.imageId,100)};});
  if(new Set(referenceAssets.map(a=>a.assetId)).size!==referenceAssets.length)throw new AiError('INVALID_INPUT');
  return{version:o.version as SourceConsistencyContext['version'],productId:uuid(o.productId),productRevision:integer(o.productRevision,1,Number.MAX_SAFE_INTEGER),variantId:uuid(o.variantId),identity,referenceAssets,...projection};
}
/** Send liability is image/spec based, independent of model, cosmetic revisions and new anchor timestamps. */
export function consistencyScopeKey(context:SourceConsistencyContext):string {
  return listingFingerprint({productId:context.productId,variantId:context.variantId,identity:context.identity,fields:context.fields,images:context.referenceAssets.map(a=>({sha256:a.sha256,byteSize:a.byteSize,imageId:a.imageId,...(a.scope?{scope:a.scope}:{})})).sort((a,b)=>a.sha256.localeCompare(b.sha256)||a.byteSize-b.byteSize||(a.imageId??'').localeCompare(b.imageId??''))});
}
/** Human authority also pins the live association epoch; broad revision is a command guard only. */
export function consistencyDecisionKey(context:SourceConsistencyContext):string {
  return listingFingerprint({scope:consistencyScopeKey(context),bindings:context.referenceAssets.map(({assetId,bindingEpoch})=>({assetId,bindingEpoch}))});
}
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
