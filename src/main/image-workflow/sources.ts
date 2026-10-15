import type { DatabaseSync } from 'node:sqlite';
import type { ProductDetail } from '../../shared/contracts.ts';
import type { ImageWorkflowApi, AutomaticSourceIssueCode } from '../../shared/image-workflow-contracts.ts';
import type { MiaoshouReceipt } from '../../shared/miaoshou-contracts.ts';
import type { WorkspaceStore } from '../store.ts';
import type { MiaoshouImageService } from '../miaoshou/images.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { AiError, throwIfAborted } from '../ai/errors.ts';
import { integer, keys, uuid, uuidList } from "../ai/primitives.ts";
import { listingFingerprint } from "../json-fingerprint.ts";
import { derivedAssetIdsForProduct } from './derived-assets.ts';
import { selectImageReferences } from "../assets/reference-selection.ts";
import { SourceImageIdentityError, readSourceImageReceipt, allowSourceUnbound, sourceImageReceipt, sourceImageMappings } from '../source-images.ts';
import type { SourceImageReceipt } from '../source-images.ts';
import { bindProductReference } from '../image-upstream-trace.ts';

export interface AutomaticImageSources { getReceipt(id: string): MiaoshouReceipt | null; images: Pick<MiaoshouImageService, 'download'> }
export type AutomaticSourcesResult = Awaited<ReturnType<ImageWorkflowApi['prepareAutomaticProductSources']>>;
export function allowUnboundSingleSku(product: ProductDetail,receipt: MiaoshouReceipt | null | undefined): boolean {
  // Deleting local variants must not turn a different source color into a shared image.
  return product.variants.length===1 && (!receipt || (receipt.snapshot.skus.length===1 && receipt.skuMappings.every(row=>row.localVariantId===product.variants[0].id)));
}
/** Read-only receipt diagnosis; never changes a mapping or downloads sibling images. */
export function sourceMappingIssue(product: ProductDetail, variantId: string, receipt: MiaoshouReceipt | null | undefined): string | null {
  return sourceMappingDiagnosis(product,variantId,receipt)?.message??null;
}
export function sourceMappingDiagnosis(product:ProductDetail,variantId:string,receipt:MiaoshouReceipt|null|undefined):{code:AutomaticSourceIssueCode;message:string}|null {
  const images=receipt?.snapshot.images.filter(image=>image.url.trim())??[];
  if(!images.length)return {code:'SOURCE_LINKS_MISSING',message:'没有可用的来源图片链接，请补充来源图片后重新准备'};
  if(allowUnboundSingleSku(product,receipt))return null;
  const mapping=receipt?.skuMappings.find(row=>row.localVariantId===variantId);
  if(!mapping)return {code:'SOURCE_MAPPING_MISSING',message:'商品有来源图片，但所选 SKU 没有来源图片映射记录，请核对来源 SKU 对应关系'};
  if(!mapping.imageIds.length){
    const variant=product.variants.find(row=>row.id===variantId),spec=variant?.sourceSpec||variant?.originalSpec||'';
    const uncertain=/可备注颜色|随机|混色/.test(spec)?`；规格“${spec.slice(0,160)}”不能证明确定颜色，请核实实际供货外观后再关联`:'';
    return {code:'SOURCE_BINDING_UNCONFIRMED',message:`商品有来源图片，但所选 SKU 的图片映射为空。请在“来源图片”下载实际对应图片，再到“图片工作区 → 关联 SKU”确认本 SKU；不会借用其他 SKU 的颜色图片${uncertain}`};
  }
  if(!mapping.imageIds.some(id=>images.some(image=>image.id===id)))return {code:'SOURCE_MAPPING_INVALID',message:'所选 SKU 的来源图片映射 ID 无效或对应链接为空，请核对来源记录'};
  return null;
}
export function sourceImageMappingDiagnosis(product:ProductDetail,variantId:string,source:SourceImageReceipt|null):{code:AutomaticSourceIssueCode;message:string}|null {
  if(source?.kind!=='native1688')return sourceMappingDiagnosis(product,variantId,source?.receipt);
  if(!source.receipt.snapshot.images.some(i=>i.url.trim()))return {code:'SOURCE_LINKS_MISSING',message:'没有可用的来源图片链接，请补充来源图片'};
  if(!sourceImageMappings(source).find(m=>m.localVariantId===variantId)?.images.length)return {code:'SOURCE_BINDING_UNCONFIRMED',message:'所选 SKU 没有确定的来源图片映射，请人工确认图片绑定'};
  return null;
}
export function parseAutomaticSources(raw: unknown) {
  const value=keys(raw,['productId','productRevision','variantIds']);
  return { productId:uuid(value.productId),productRevision:integer(value.productRevision,1,Number.MAX_SAFE_INTEGER),variantIds:uuidList(value.variantIds,200,1) };
}
function sourceStamp(product: ProductDetail): string {
  const { assets: _assets, revision: _revision, updatedAt: _updatedAt, ...source }=product;
  return listingFingerprint(source);
}

/** Download only source-owned SKU references, before taking the draft's product revision. */
export async function prepareImageWorkflowSources(store: WorkspaceStore,db: DatabaseSync,sources: AutomaticImageSources | undefined,raw: unknown,signal: AbortSignal): Promise<AutomaticSourcesResult> {
  const input=parseAutomaticSources(raw); throwIfAborted(signal);
  let product=store.assertRevision({productId:input.productId,revision:input.productRevision});
  if(input.variantIds.some(id=>!product.variants.some(variant=>variant.id===id)))throw new UserFacingError('商品 SKU 已变化');
  const resolve=()=>sources?sourceImageReceipt(store.getCollectionReceipt(product.id),sources.getReceipt(product.id)):readSourceImageReceipt(db,product.id);
  let source:SourceImageReceipt|null;
  try{source=resolve();}catch(error){return {product,missing:input.variantIds.map(variantId=>({variantId,code:error instanceof SourceImageIdentityError?'SOURCE_IDENTITY_CONFLICT':'SOURCE_STORAGE_INVALID',message:error instanceof SourceImageIdentityError?error.message:'来源图片记录无法校验，请修复来源记录后重试'}))};}
  const receipt=source?.receipt,allowUnbound=allowSourceUnbound(product,source);
  const mappings=source?sourceImageMappings(source):[];
  const originalStamp=sourceStamp(product),derived=derivedAssetIdsForProduct(db,product.id);
  const ready=(variantId:string)=>{
    try { selectImageReferences(product,variantId,derived,(assetId,id)=>Boolean(db.prepare('SELECT 1 FROM variant_assets WHERE asset_id=? AND variant_id=? AND confirmed=1').get(assetId,id)),allowUnbound&&!mappings.find(row=>row.localVariantId===variantId)?.images.length);return true; }
    catch(error) { if(error instanceof UserFacingError)return false;throw error; }
  };
  const receiptStamp=listingFingerprint(source),attempted=new Set<string>(),failedUrls=new Map<string,string>();
  const imageUrl=(id:string)=>receipt?.snapshot.images.find(i=>i.id===id)?.url??'';
  const session={createdAssets:new Set<string>(),variantIds:input.variantIds};
  const productReferences=new Set<string>();
  const candidates=new Map(input.variantIds.map(variantId=>{
    const mapped=[...(mappings.find(row=>row.localVariantId===variantId)?.images??[])].sort((a,b)=>Number(a.basis==='spec-value')-Number(b.basis==='spec-value')).map(i=>i.imageId);
    // Explicit supplier SKU images outrank generic single-SKU gallery order.
    // Do not let a generic original satisfy a mapped SKU then fail consistency later.
    let ids=mapped.length?mapped.filter(id=>imageUrl(id).trim()):source?.kind==='native1688'?[]:receipt?.snapshot.images.filter(image=>image.url.trim() && allowUnbound).map(image=>image.id)??[];
    const variant=product.variants.find(v=>v.id===variantId)!,spec=(variant.sourceSpec||variant.originalSpec).trim();
    if(!ids.length&&!mapped.length&&mappings.some(m=>m.localVariantId===variantId)&&spec&&!/规格待核对/.test(spec)){
      // Known sibling thumbnails are not generic gallery references.
      ids=receipt?.snapshot.images.filter(i=>i.url.trim()&&i.role!=='detail'&&!mappings.some(m=>m.images.some(image=>image.imageId===i.id))).map(i=>i.id)??[];
      if(ids.length)productReferences.add(variantId);
    }
    return [variantId,ids.slice(0,3)];
  }));
  const fresh=()=>{
    throwIfAborted(signal);
    const current=store.getProduct(product.id);
    if(current.revision!==product.revision || sourceStamp(current)!==originalStamp || listingFingerprint(resolve())!==receiptStamp)throw new AiError('SOURCE_CHANGED');
  };
  // At most three different source candidates per SKU; a failed URL is never retried in this run.
  for(let round=0;sources&&receipt&&round<3;round++) {
    fresh();
    const urls=new Set<string>();
    const ids=[...new Set(input.variantIds.filter(id=>!ready(id)).flatMap(id=>{
      const next=candidates.get(id)!.find(imageId=>!attempted.has(imageId)&&!failedUrls.has(imageUrl(imageId)));return next?[next]:[];
    }))].filter(id=>{const url=imageUrl(id);if(urls.has(url))return false;urls.add(url);return true;});
    if(!ids.length)break;
    for(let offset=0;offset<ids.length;offset+=20) {
      fresh();const imageIds=ids.slice(offset,offset+20);imageIds.forEach(id=>attempted.add(id));
      const downloaded=await sources.images.download({productId:product.id,revision:product.revision,imageIds},signal,session);
      product=downloaded.product; fresh();
      for(const variantId of productReferences){
        if(ready(variantId))continue;
        const ids=candidates.get(variantId)!;
        const anchor=db.prepare("SELECT record_json FROM source_image_provenance WHERE json_extract(record_json,'$.productId')=? ORDER BY rowid DESC").all(product.id).map(row=>JSON.parse(String(row.record_json))).find(row=>row.receiptId===receipt.id&&row.receiptKind===source?.kind&&ids.includes(row.imageId)&&imageIds.includes(row.imageId));
        if(anchor){const variant=product.variants.find(v=>v.id===variantId)!;bindProductReference(db,{productId:product.id,variantId,assetId:anchor.assetId,imageId:anchor.imageId,sourceSku:mappings.find(m=>m.localVariantId===variantId)!.sourceSku,spec:variant.sourceSpec||variant.originalSpec});product=store.getProduct(product.id);}
      }
      for(const failure of downloaded.failures)failedUrls.set(imageUrl(failure.imageId),failure.message);
    }
  }
  fresh();
  return {product,missing:input.variantIds.filter(id=>!ready(id)).map(variantId=>{
    const failure=candidates.get(variantId)?.map(id=>failedUrls.get(imageUrl(id))).find(Boolean);
    const mappingIssue=sourceImageMappingDiagnosis(product,variantId,source);
    const localUnconfirmed=product.assets.some(asset=>!derived.has(asset.id)&&asset.variantIds.includes(variantId)&&!db.prepare('SELECT 1 FROM variant_assets WHERE asset_id=? AND variant_id=? AND confirmed=1').get(asset.id,variantId));
    const issue:{code:AutomaticSourceIssueCode;message:string}=localUnconfirmed?{code:'SOURCE_BINDING_UNCONFIRMED',message:'该 SKU 的来源图片绑定尚未确认，请确认图片与 SKU 的对应关系'}
      :mappingIssue??(!sources&&candidates.get(variantId)?.length?{code:'SOURCE_DOWNLOAD_FAILED',message:'来源图片下载服务不可用，请重新加载工作区后重试'}:failure?{code:'SOURCE_DOWNLOAD_FAILED',message:`来源图片下载失败：${failure}`}:{code:'SOURCE_REFERENCE_UNUSABLE',message:'来源图片已处理，但该 SKU 的图片绑定仍未确认，或参考图超出可用大小限制，请核对来源图片'});
    return {variantId,...issue};
  })};
}
