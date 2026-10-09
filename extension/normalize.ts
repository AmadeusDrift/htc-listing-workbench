import type { CollectionSnapshot, CollectionSourceSku, CollectionSourceImage, CollectionSkuImage, CollectionWarningCode } from '../src/shared/collection-contracts.ts';

type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const clean = (value: unknown, max: number) => typeof value === 'string' && value.length <= max ? value.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '') : '';
function decimal(value: unknown): string | null {
  // Binary floating-point page values cannot establish the supplier's decimal precision.
  const text = typeof value === 'string' ? value.trim() : Number.isSafeInteger(value) && Number(value) >= 0 ? String(value) : '';
  return /^(?:0|[1-9]\d{0,7})(?:\.\d{1,12})?$/.test(text) ? text : null;
}
function comparePrice(a: string, b: string): number {
  const scaled = (value: string) => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole + fraction.padEnd(12, '0')); };
  return scaled(a) < scaled(b) ? -1 : scaled(a) > scaled(b) ? 1 : 0;
}
function imageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !url.hostname.endsWith('.alicdn.com') || /[\\\s]/.test(value)) return null;
    for (const key of url.searchParams.keys()) if (/(?:token|cookie|auth|secret|signature|credential|session|password|key)/i.test(key)) return null;
    return url.href;
  } catch { return null; }
}
export function normalizePage(input: unknown, capturedAt = new Date().toISOString()): CollectionSnapshot {
  const raw = object(input);
  if (raw.blocked) throw new Error('CHALLENGE_PAGE');
  if (raw.tooLarge) throw new Error('TOO_LARGE');
  let source: URL;
  try { source = new URL(String(raw.url)); } catch { throw new Error('INVALID_SOURCE'); }
  const match = /^\/offer\/([1-9]\d{0,19})\.html$/.exec(source.pathname);
  if (source.protocol !== 'https:' || source.hostname !== 'detail.1688.com' || source.port || source.username || source.password || !match) throw new Error('INVALID_SOURCE');
  const offerId = match[1];
  if (raw.offerId !== undefined && raw.offerId !== null && String(raw.offerId) !== offerId) throw new Error('INVALID_SOURCE');
  const warnings = new Set<CollectionWarningCode>();
  const title = clean(raw.title, 500);
  if (!title) warnings.add('MISSING_TITLE');
  const imageList: CollectionSourceImage[] = [], skuImages: CollectionSkuImage[] = [];
  const addImage = (value: unknown, role: CollectionSourceImage['role']) => {
    const url = imageUrl(value); if (!url) return null;
    const old = imageList.find(image => image.url === url); if (old) return old.id;
    if (imageList.length >= 200) throw new Error('TOO_LARGE');
    const id = `image-${imageList.length + 1}`; imageList.push({ id, url, role }); return id;
  };
  if (Array.isArray(raw.images)) for (const [i, value] of raw.images.entries()) addImage(value, i === 0 ? 'main' : 'gallery');
  if (Array.isArray(raw.detailImages)) for (const value of raw.detailImages) addImage(value, 'detail');
  const skus: CollectionSourceSku[] = [];
  if (Array.isArray(raw.skus)) {
    if (raw.skus.length > 200) throw new Error('TOO_MANY_SKUS');
    for (const item of raw.skus) {
      const row = object(item), providerSkuId = clean(typeof row.skuId === 'number' && Number.isSafeInteger(row.skuId) ? String(row.skuId) : row.skuId, 128);
      if (!/^[A-Za-z0-9_-]+$/.test(providerSkuId)) { warnings.add('SKU_STRUCTURE_UNRECOGNIZED'); continue; }
      if (skus.some(sku => sku.providerSkuId === providerSkuId)) throw new Error('INVALID_SNAPSHOT');
      const attributes: { name: string; value: string }[] = [];
      if (Array.isArray(row.specAttrs)) {
        if (row.specAttrs.length > 20) throw new Error('INVALID_SNAPSHOT');
        for (const item of row.specAttrs) {
          const attr = object(item), name = clean(attr.propName, 100), value = clean(attr.valueName, 500);
          if (!name || !value || attributes.some(a => a.name === name)) throw new Error('INVALID_SNAPSHOT');
          attributes.push({ name, value });
        }
      }
      const originalSpec = attributes.length ? attributes.map(a => `${a.name}: ${a.value}`).join('；') : clean(row.specAttrs, 2000);
      if (originalSpec.length > 2000) throw new Error('INVALID_SNAPSHOT');
      if (!originalSpec) warnings.add('SKU_STRUCTURE_UNRECOGNIZED');
      const purchasePrice = decimal(row.price);
      skus.push({ providerSkuId, originalSpec, attributes, purchasePrice });
      const id = addImage(row.imageUrl, 'gallery');
      if (id) skuImages.push({ providerSkuId, imageId: id, basis: 'provider-sku-id', specName: null, specValue: null });
    }
  } else if (raw.skus !== undefined && raw.skus !== null) warnings.add('SKU_STRUCTURE_UNRECOGNIZED');
  if (!skus.length) warnings.add('MISSING_SKUS');
  const tiers: { minQuantity: number; unitPrice: string }[] = [];
  if (Array.isArray(raw.prices)) {
    if (raw.prices.length > 50) throw new Error('INVALID_SNAPSHOT');
    const quantities = new Set<number>();
    for (const item of raw.prices) {
      const row = object(item), quantity = typeof row.beginAmount === 'string' && /^[1-9]\d{0,8}$/.test(row.beginAmount) ? Number(row.beginAmount) : row.beginAmount;
      const price = decimal(row.price);
      if (Number.isSafeInteger(quantity) && Number(quantity) > 0 && Number(quantity) <= 999999999) {
        if (quantities.has(Number(quantity))) throw new Error('INVALID_SNAPSHOT');
        quantities.add(Number(quantity));
        if (price) tiers.push({ minQuantity: Number(quantity), unitPrice: price });
        else warnings.add('MISSING_PRICE');
      } else warnings.add('MISSING_PRICE');
    }
  }
  tiers.sort((a, b) => a.minQuantity - b.minQuantity);
  let range: { min: string; max: string } | null = null;
  if (typeof raw.priceDisplay === 'string') {
    const parts = raw.priceDisplay.trim().split(/\s*[-~～]\s*/);
    if (parts.length === 2) { const min = decimal(parts[0]), max = decimal(parts[1]); if (min && max && comparePrice(min, max) <= 0) range = { min, max }; }
  }
  const unitPrice = decimal(raw.unitPrice) ?? decimal(raw.priceDisplay);
  const allPrices = [unitPrice, range?.min, range?.max, ...tiers.map(t => t.unitPrice), ...skus.map(s => s.purchasePrice)].filter((v): v is string => typeof v === 'string');
  if (!allPrices.length || skus.some(s => s.purchasePrice === null)) warnings.add('MISSING_PRICE');
  if (allPrices.some(p => (p.split('.')[1]?.length ?? 0) > 4)) warnings.add('PRICE_PRECISION_UNSUPPORTED');
  if (!imageList.length) warnings.add('MISSING_IMAGES'); else warnings.add('REMOTE_IMAGES_ONLY');
  if (skus.some(s => !skuImages.some(m => m.providerSkuId === s.providerSkuId))) warnings.add('INCOMPLETE_SKU_IMAGES');
  return { source: '1688', offerId, sourceUrl: `https://detail.1688.com/offer/${offerId}.html`, capturedAt, title, skus, pricing: { currency: 'CNY', unitPrice, range, tiers }, images: imageList, skuImages, warnings: [...warnings].sort() };
}
