import type { ProcurementBatch, ProcurementLine } from '../../shared/procurement-contracts.ts';
import { identifier, record, text } from '../../shared/validation.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { safeUrl } from '../miaoshou/validation.ts';
import { ITEM_LABEL_STATUSES } from '../../shared/item-label-contracts.ts';
import { validateSalesRecipe } from '../sales-plans/records.ts';

export function quantity(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 1000000) throw new UserFacingError('数量需要为 0–1000000 的整数或留空');
  return value as number;
}
export function price(value: unknown): string {
  const result = text(value, '采购价', 20);
  if (result && !/^\d{1,8}(?:\.\d{1,4})?$/.test(result)) throw new UserFacingError('采购价需要为非负数，最多 4 位小数');
  return result;
}
export function timestamp(value: unknown): string {
  const result = text(value, '时间', 24, true);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) throw new UserFacingError('备货记录时间无效');
  return result;
}
function nullableCode(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[A-Z0-9]{10}$/.test(value)) throw new UserFacingError('商品平台标识无效');
  return value;
}
function url(value: unknown): string { const result = text(value, '来源地址', 2048); if (result && safeUrl(result) !== result) throw new UserFacingError('备货来源地址无效'); return result; }
export function shipmentId(value: unknown): string {
  const result = text(value, '已有货件号', 100);
  if (result && !/^[A-Za-z0-9][A-Za-z0-9_-]{4,99}$/.test(result)) throw new UserFacingError('货件号只能包含英文字母、数字、横线或下划线');
  return result;
}
function validateLine(raw: unknown): ProcurementLine {
  const v = record(raw, '备货行', ['id','draftId','productId','variantId','title','spec','sku','targetId','targetName','sellerId','marketplaceId','sourceUrl','sourceItemId','sourceSkuKey','sourceUrlBasis','imageAssetId','sourceImageUrl','sourcePurchasePrice','currency','asin','fnsku','checkedAt','purchaseQuantity','stockQuantity','purchasePrice','purchaseUnit','priceConfirmed','labelStatus','salesRecipe','basis']);
  if (!['product','miaoshou','item-id','missing'].includes(String(v.sourceUrlBasis)) || !['CNY','unknown'].includes(String(v.currency)) || !ITEM_LABEL_STATUSES.includes(v.labelStatus as never) || typeof v.priceConfirmed !== 'boolean') throw new UserFacingError('备货行状态无效');
  const result: ProcurementLine = { id: identifier(v.id), draftId: identifier(v.draftId), productId: identifier(v.productId), variantId: identifier(v.variantId),
    title: text(v.title, '商品名称', 500, true), spec: text(v.spec, '规格', 2000), sku: text(v.sku, 'SKU', 100, true),
    targetId: text(v.targetId, '店铺', 100, true), targetName: text(v.targetName, '店铺名称', 200, true), sellerId: text(v.sellerId, '卖家', 100, true), marketplaceId: text(v.marketplaceId, '站点', 100, true),
    sourceUrl: url(v.sourceUrl), sourceItemId: text(v.sourceItemId, '来源商品 ID', 128), sourceSkuKey: text(v.sourceSkuKey, '来源规格键', 2000), sourceUrlBasis: v.sourceUrlBasis as ProcurementLine['sourceUrlBasis'],
    imageAssetId: v.imageAssetId === null ? null : identifier(v.imageAssetId), sourceImageUrl: url(v.sourceImageUrl), sourcePurchasePrice: price(v.sourcePurchasePrice), currency: v.currency as ProcurementLine['currency'],
    asin: nullableCode(v.asin), fnsku: nullableCode(v.fnsku), checkedAt: v.checkedAt === null ? null : timestamp(v.checkedAt),
    purchaseQuantity: quantity(v.purchaseQuantity), stockQuantity: quantity(v.stockQuantity), purchasePrice: price(v.purchasePrice), purchaseUnit: text(v.purchaseUnit, '采购单位', 40), priceConfirmed: v.priceConfirmed, labelStatus: v.labelStatus as ProcurementLine['labelStatus'] };
  if (result.priceConfirmed && !result.purchasePrice) throw new UserFacingError('确认采购价前需要填写价格');
  if(v.salesRecipe!==undefined)result.salesRecipe=validateSalesRecipe(v.salesRecipe);
  if(v.basis!==undefined){
    const b=record(v.basis,'采购依据版本',['productRevision','sourceHash','recipeHash','observationHash']);
    if(!Number.isSafeInteger(b.productRevision)||Number(b.productRevision)<1||!['sourceHash','recipeHash','observationHash'].every(key=>(key!=='sourceHash'&&b[key]===null)||typeof b[key]==='string'&&/^[a-f0-9]{64}$/.test(b[key] as string)))throw new UserFacingError('采购依据版本无效');
    result.basis={productRevision:Number(b.productRevision),sourceHash:b.sourceHash as string,recipeHash:b.recipeHash as string|null,observationHash:b.observationHash as string|null};
  }
  if ((result.sourceUrlBasis === 'missing') !== !result.sourceUrl) throw new UserFacingError('来源链接与依据不一致');
  return result;
}
export function validateProcurementBatch(raw: unknown): ProcurementBatch {
  const v = record(raw, '备货批次', ['id','code','name','revision','mode','createdAt','updatedAt','lines','shipment','automaticJobId']);
  if (!['live','demo'].includes(String(v.mode)) || !Number.isSafeInteger(v.revision) || Number(v.revision) < 1 || !Array.isArray(v.lines) || !v.lines.length || v.lines.length > 5000) throw new UserFacingError('备货批次状态或行数无效');
  const lines = v.lines.map(validateLine), identities = lines.map(line => JSON.stringify([line.targetId,line.sellerId,line.marketplaceId,line.sku]));
  if (new Set(lines.map(line => line.id)).size !== lines.length || new Set(identities).size !== lines.length || new Set(lines.map(line => JSON.stringify([line.targetId,line.sellerId,line.marketplaceId]))).size !== 1) throw new UserFacingError('同一批次不能包含重复 SKU 或不同店铺');
  let shipment: ProcurementBatch['shipment'] = null;
  if (v.shipment !== null) {
    const s = record(v.shipment, '货件关联', ['confirmationId','status','linkedAt']);
    if (s.status !== 'LINKED_UNVERIFIED') throw new UserFacingError('货件关联状态无效');
    const confirmationId = shipmentId(s.confirmationId); if (!confirmationId) throw new UserFacingError('关联的货件号不能为空');
    shipment = { confirmationId, status: 'LINKED_UNVERIFIED', linkedAt: timestamp(s.linkedAt) };
  }
  const value: ProcurementBatch = { id: identifier(v.id), code: text(v.code, '批次编号', 100, true), name: text(v.name, '批次名称', 100, true), revision: Number(v.revision), mode: v.mode as ProcurementBatch['mode'], createdAt: timestamp(v.createdAt), updatedAt: timestamp(v.updatedAt), lines, shipment };
  if (v.automaticJobId !== undefined) value.automaticJobId = identifier(v.automaticJobId);
  if (Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024) throw new UserFacingError('本批备货资料过多，请拆分批次');
  return value;
}
