import type { AmazonTarget } from '../../shared/amazon-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';

export type ProductDataKind = 'listings' | 'inventory' | 'sales';
export function productDataRequest(target: AmazonTarget, kind: ProductDataKind, input: Record<string,string>) {
  const fail = (): never => { throw new UserFacingError('商品数据请求必须限定当前店铺和本软件上传的 SKU'); };
  if (target.mode !== 'live' || !input || typeof input !== 'object' || Array.isArray(input)) fail();
  const fields = kind === 'listings' ? ['marketplaceIds','identifiers','identifiersType','includedData','pageSize','pageToken','issueLocale']
    : kind === 'inventory' ? ['marketplaceIds','granularityType','granularityId','details','sellerSkus','sellerSku','nextToken']
    : kind === 'sales' ? ['marketplaceIds','sku','interval','granularity','granularityTimeZone','amazonProgram'] : fail();
  for (const [key,value] of Object.entries(input)) if (!fields.includes(key) || typeof value !== 'string' || value.length > 16000 || /[\u0000-\u001f]/.test(value)) fail();
  if (input.marketplaceIds && input.marketplaceIds !== target.marketplaceId) fail();
  const query: Record<string,string> = {...input,marketplaceIds:target.marketplaceId};
  const sku = (value: string | undefined) => typeof value === 'string' && value.trim().length > 0 && value.length <= 255;
  if (kind === 'listings') {
    const identifiers = query.identifiers?.split(',') ?? [];
    if (!identifiers.length || identifiers.length > 20 || !identifiers.every(sku) || query.identifiersType !== 'SKU' || !['10','20'].includes(query.pageSize ?? '20')) fail();
    if (query.includedData?.split(',').some(value => !['summaries','attributes','issues'].includes(value))) fail();
    return {operation:'searchListingsItems',path:'/listings/2021-08-01/items/'+encodeURIComponent(target.sellerId),query,interval:250};
  }
  if (kind === 'inventory') {
    const skus = query.sellerSkus?.split(',') ?? [];
    if (query.sellerSku ? !sku(query.sellerSku) || !!query.sellerSkus : !skus.length || skus.length > 50 || !skus.every(sku)) fail();
    if (query.granularityType !== 'Marketplace' || query.granularityId !== target.marketplaceId || query.details !== 'true') fail();
    return {operation:'getInventorySummaries',path:'/fba/inventory/v1/summaries',query,interval:550};
  }
  const times = query.interval?.split('--') ?? [], start = Date.parse(times[0]), end = Date.parse(times[1]);
  if (!sku(query.sku) || times.length !== 2 || !Number.isFinite(start) || !Number.isFinite(end) || start >= end || end-start > 31*86400000 || !times.every(value => /Z$/.test(value))) fail();
  if (query.amazonProgram !== 'AmazonHaul' || query.granularity !== 'Day' || query.granularityTimeZone !== 'UTC') fail();
  return {operation:'getOrderMetrics',path:'/sales/v1/orderMetrics',query,interval:2100};
}
