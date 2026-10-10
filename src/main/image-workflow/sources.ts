import type { DatabaseSync } from 'node:sqlite';
import type { ProductDetail } from '../../shared/contracts.ts';
import type { ImageWorkflowApi, AutomaticSourceIssueCode } from '../../shared/image-workflow-contracts.ts';
import type { MiaoshouReceipt } from '../../shared/miaoshou-contracts.ts';
import type { WorkspaceStore } from '../store.ts';
import type { MiaoshouImageService } from '../miaoshou/images.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { AiError, throwIfAborted } from '../ai/errors.ts';
import { integer, keys, uuid, uuidList } from '../ai/validation.ts';
import { listingFingerprint } from '../listing-ai/validation.ts';
import { selectImageReferences, workflowRuns } from './records.ts';

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
  const receipt=sources?.getReceipt(product.id),allowUnbound=allowUnboundSingleSku(product,receipt);
  const originalStamp=sourceStamp(product),derived=new Set(workflowRuns(db).flatMap(run=>run.slots?run.slots.flatMap(slot=>slot.approvedAssetId?[slot.approvedAssetId]:[]):run.approvedAssetId?[run.approvedAssetId]:[]));
  const ready=(variantId:string)=>{
    try { selectImageReferences(product,variantId,derived,(assetId,id)=>Boolean(db.prepare('SELECT 1 FROM variant_assets WHERE asset_id=? AND variant_id=? AND confirmed=1').get(assetId,id)),allowUnbound);return true; }
    catch(error) { if(error instanceof UserFacingError)return false;throw error; }
  };
  const receiptStamp=listingFingerprint(receipt??null),attempted=new Set<string>(),failures=new Map<string,string>();
  const session={createdAssets:new Set<string>()};
  const candidates=new Map(input.variantIds.map(variantId=>{
    const mapped=receipt?.skuMappings.find(row=>row.localVariantId===variantId)?.imageIds??[];
    const ids=receipt?.snapshot.images.filter(image=>image.url.trim() && (mapped.includes(image.id) || allowUnbound)).map(image=>image.id)??[];
    return [variantId,ids.slice(0,3)];
  }));
  const fresh=()=>{
    throwIfAborted(signal);
    const current=store.getProduct(product.id);
    if(current.revision!==product.revision || sourceStamp(current)!==originalStamp || listingFingerprint(sources?.getReceipt(product.id)??null)!==receiptStamp)throw new AiError('SOURCE_CHANGED');
  };
  // At most three different source candidates per SKU; a failed URL is never retried in this run.
  for(let round=0;sources&&receipt&&round<3;round++) {
    fresh();
    const ids=[...new Set(input.variantIds.filter(id=>!ready(id)).flatMap(id=>{
      const next=candidates.get(id)!.find(imageId=>!attempted.has(imageId));return next?[next]:[];
    }))];
    if(!ids.length)break;
    for(let offset=0;offset<ids.length;offset+=20) {
      fresh();const imageIds=ids.slice(offset,offset+20);imageIds.forEach(id=>attempted.add(id));
      const downloaded=await sources.images.download({productId:product.id,revision:product.revision,imageIds},signal,session);
      product=downloaded.product; fresh();
      for(const failure of downloaded.failures)failures.set(failure.imageId,failure.message);
    }
  }
  fresh();
  return {product,missing:input.variantIds.filter(id=>!ready(id)).map(variantId=>{
    const failure=candidates.get(variantId)?.map(id=>failures.get(id)).find(Boolean);
    const mappingIssue=sourceMappingDiagnosis(product,variantId,receipt);
    const localUnconfirmed=product.assets.some(asset=>!derived.has(asset.id)&&asset.variantIds.includes(variantId)&&!db.prepare('SELECT 1 FROM variant_assets WHERE asset_id=? AND variant_id=? AND confirmed=1').get(asset.id,variantId));
    const issue:{code:AutomaticSourceIssueCode;message:string}=localUnconfirmed?{code:'SOURCE_BINDING_UNCONFIRMED',message:'该 SKU 的来源图片绑定尚未确认，请确认图片与 SKU 的对应关系'}
      :mappingIssue??(failure?{code:'SOURCE_DOWNLOAD_FAILED',message:`来源图片下载失败：${failure}`}:{code:'SOURCE_REFERENCE_UNUSABLE',message:'来源图片已处理，但该 SKU 的图片绑定仍未确认，或参考图超出可用大小限制，请核对来源图片'});
    return {variantId,...issue};
  })};
}
