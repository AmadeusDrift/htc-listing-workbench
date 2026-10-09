import { createHash } from 'node:crypto';
import { UserFacingError } from '../../shared/errors.ts';
import { COLLECTION_MAX_MESSAGE_BYTES, COLLECTION_WARNING_CODES } from '../../shared/collection-contracts.ts';
import type { CollectionCaptureRecord, CollectionErrorCode, CollectionReceipt, CollectionRequest, CollectionSkuImage, CollectionSnapshot, CollectionWarningCode } from '../../shared/collection-contracts.ts';

export class CollectionError extends UserFacingError {
  readonly code: CollectionErrorCode;
  constructor(code: CollectionErrorCode) { super(code); this.code = code; }
}
const fail = (code: CollectionErrorCode = 'INVALID_SNAPSHOT'): never => { throw new CollectionError(code); };
export function exactObject(value: unknown, keys: readonly string[], code: CollectionErrorCode = 'INVALID_SNAPSHOT'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(code);
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== keys.length || Object.keys(object).some(key => !keys.includes(key))) return fail(code);
  return object;
}
export function collectionId(raw: unknown, code: CollectionErrorCode = 'INVALID_SNAPSHOT'): string {
  if (typeof raw !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(raw)) return fail(code);
  return raw;
}
function string(raw: unknown, max: number, required = true): string {
  if (typeof raw !== 'string' || raw.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(raw)) return fail();
  const value = raw.trim(); if (required && !value) return fail(); return value;
}
function list(raw: unknown, max: number): unknown[] { if (!Array.isArray(raw) || raw.length > max) return fail(); return raw; }
function unique(values: string[]): void { if (new Set(values).size !== values.length) fail(); }
function timestamp(raw: unknown): string { const value = string(raw, 24); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return fail(); return value; }
function decimal(raw: unknown): string { const value = string(raw, 21); if (!/^\d{1,8}(?:\.\d{1,12})?$/.test(value)) return fail(); return value; }
function optionalDecimal(raw: unknown): string | null { return raw === null ? null : decimal(raw); }
export function localCollectionPrice(raw: string | null): string { return raw !== null && /^\d{1,8}(?:\.\d{1,4})?$/.test(raw) ? raw : ''; }
function scaledDecimal(value: string): bigint { const [integer, fraction = ''] = value.split('.'); return BigInt(integer + fraction.padEnd(12, '0')); }
const imageId = (raw: unknown) => { const value = string(raw, 64); if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) return fail(); return value; };
const providerSkuId = (raw: unknown) => { const value = string(raw, 128); if (!/^[A-Za-z0-9_-]+$/.test(value)) return fail(); return value; };
function imageUrl(raw: unknown): string {
  const value = string(raw, 2048); let url: URL;
  try { url = new URL(value); } catch { return fail(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || !url.hostname.endsWith('.alicdn.com')
    || url.hostname.endsWith('.') || !url.pathname || /[\\\s]/.test(value)) return fail();
  for (const key of url.searchParams.keys()) if (/(?:token|cookie|auth|secret|signature|credential|session|password|key)/i.test(key)) fail();
  return url.href;
}

export function validateCollectionSnapshot(raw: unknown): CollectionSnapshot {
  const value = exactObject(raw, ['source', 'offerId', 'sourceUrl', 'capturedAt', 'title', 'skus', 'pricing', 'images', 'skuImages', 'warnings']);
  if (value.source !== '1688' || typeof value.offerId !== 'string' || !/^[1-9]\d{0,31}$/.test(value.offerId)
    || value.sourceUrl !== `https://detail.1688.com/offer/${value.offerId}.html`) return fail('INVALID_SOURCE');
  if (Array.isArray(value.skus) && value.skus.length > 200) return fail('TOO_MANY_SKUS');
  const skus = list(value.skus, 200).map(rawSku => {
    const sku = exactObject(rawSku, ['providerSkuId', 'originalSpec', 'attributes', 'purchasePrice']);
    const attributes = list(sku.attributes, 20).map(rawAttribute => { const a = exactObject(rawAttribute, ['name', 'value']); return { name: string(a.name, 100), value: string(a.value, 500) }; });
    unique(attributes.map(a => a.name));
    return { providerSkuId: providerSkuId(sku.providerSkuId), originalSpec: string(sku.originalSpec, 2000, false), attributes, purchasePrice: optionalDecimal(sku.purchasePrice) };
  });
  unique(skus.map(sku => sku.providerSkuId));
  const pricing = exactObject(value.pricing, ['currency', 'unitPrice', 'range', 'tiers']); if (pricing.currency !== 'CNY') return fail();
  let range: { min: string; max: string } | null = null;
  if (pricing.range !== null) { const rawRange = exactObject(pricing.range, ['min', 'max']); range = { min: decimal(rawRange.min), max: decimal(rawRange.max) }; if (scaledDecimal(range.min) > scaledDecimal(range.max)) return fail(); }
  const tiers = list(pricing.tiers, 50).map(rawTier => { const tier = exactObject(rawTier, ['minQuantity', 'unitPrice']); if (!Number.isSafeInteger(tier.minQuantity) || Number(tier.minQuantity) < 1 || Number(tier.minQuantity) > 999999999) return fail(); return { minQuantity: Number(tier.minQuantity), unitPrice: decimal(tier.unitPrice) }; });
  if (tiers.some((tier, index) => index > 0 && tier.minQuantity <= tiers[index - 1].minQuantity)) return fail();
  const images = list(value.images, 200).map(rawImage => { const image = exactObject(rawImage, ['id', 'url', 'role']); if (!['main', 'gallery', 'detail'].includes(String(image.role))) return fail(); return { id: imageId(image.id), url: imageUrl(image.url), role: image.role as 'main' | 'gallery' | 'detail' }; });
  unique(images.map(image => image.id)); unique(images.map(image => `${image.role}\0${image.url}`));
  const skuImages = list(value.skuImages, 2000).map<CollectionSkuImage>(rawBinding => {
    const binding = exactObject(rawBinding, ['providerSkuId', 'imageId', 'basis', 'specName', 'specValue']);
    const providerSkuId = string(binding.providerSkuId, 128), boundImageId = imageId(binding.imageId), sku = skus.find(sku => sku.providerSkuId === providerSkuId);
    if (!sku || !images.some(image => image.id === boundImageId)) return fail();
    if (binding.basis === 'provider-sku-id') { if (binding.specName !== null || binding.specValue !== null) return fail(); return { providerSkuId, imageId: boundImageId, basis: binding.basis, specName: null, specValue: null }; }
    if (binding.basis !== 'spec-value') return fail();
    const specName = string(binding.specName, 100), specValue = string(binding.specValue, 500);
    if (!sku.attributes.some(attribute => attribute.name === specName && attribute.value === specValue)) return fail();
    return { providerSkuId, imageId: boundImageId, basis: binding.basis, specName, specValue };
  });
  unique(skuImages.map(binding => `${binding.providerSkuId}\0${binding.imageId}`));
  const submittedWarnings = list(value.warnings, COLLECTION_WARNING_CODES.length).map(raw => { if (!COLLECTION_WARNING_CODES.includes(raw as CollectionWarningCode)) return fail(); return raw as CollectionWarningCode; }); unique(submittedWarnings);
  const warnings = new Set<CollectionWarningCode>(submittedWarnings), title = string(value.title, 500, false), unitPrice = optionalDecimal(pricing.unitPrice);
  if (!title) warnings.add('MISSING_TITLE'); if (!skus.length) warnings.add('MISSING_SKUS');
  if (!unitPrice && !range && !tiers.length && !skus.some(sku => sku.purchasePrice !== null)) warnings.add('MISSING_PRICE');
  if (!images.length) warnings.add('MISSING_IMAGES'); else warnings.add('REMOTE_IMAGES_ONLY');
  if (skus.some(sku => sku.purchasePrice !== null && !localCollectionPrice(sku.purchasePrice))) warnings.add('PRICE_PRECISION_UNSUPPORTED');
  if (skus.length && images.length && skus.some(sku => !skuImages.some(binding => binding.providerSkuId === sku.providerSkuId))) warnings.add('INCOMPLETE_SKU_IMAGES');
  return { source: '1688', offerId: value.offerId, sourceUrl: value.sourceUrl as string, capturedAt: timestamp(value.capturedAt), title, skus,
    pricing: { currency: 'CNY', unitPrice, range, tiers }, images, skuImages, warnings: COLLECTION_WARNING_CODES.filter(code => warnings.has(code)) };
}

export function collectionFingerprint(snapshot: CollectionSnapshot): string {
  const { capturedAt: _capturedAt, ...content } = validateCollectionSnapshot(snapshot);
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/** Preserve duplicate-key visibility across the native host; JSON.parse alone silently replaces values. */
export function parseUnambiguousJson(bytes: Uint8Array, maxBytes = COLLECTION_MAX_MESSAGE_BYTES): unknown {
  if (!bytes.length) return fail('INVALID_MESSAGE'); if (bytes.length > maxBytes) return fail('TOO_LARGE');
  try {
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes), parsed: unknown = JSON.parse(raw); let position = 0;
    const space = () => { while (/\s/.test(raw[position] ?? '') && position < raw.length) position++; };
    function quoted(): string { const start = position++; while (position < raw.length) { if (raw[position] === '\\') position += 2; else if (raw[position++] === '"') return JSON.parse(raw.slice(start, position)) as string; } return fail('INVALID_MESSAGE'); }
    function visit(depth: number): void {
      if (depth > 32) fail('INVALID_MESSAGE'); space();
      if (raw[position] === '"') { quoted(); return; }
      if (raw[position] === '{') { position++; space(); const keys = new Set<string>(); if (raw[position] === '}') { position++; return; }
        while (position < raw.length) { space(); const key = quoted(); if (keys.has(key)) fail('INVALID_MESSAGE'); keys.add(key); space(); position++; visit(depth + 1); space(); if (raw[position++] === '}') return; }
      } else if (raw[position] === '[') { position++; space(); if (raw[position] === ']') { position++; return; } while (position < raw.length) { visit(depth + 1); space(); if (raw[position++] === ']') return; } }
      else { while (position < raw.length && !/[\s,\]}]/.test(raw[position])) position++; }
    }
    visit(0); return parsed;
  } catch (error) { if (error instanceof CollectionError) throw error; return fail('INVALID_MESSAGE'); }
}

export function parseCollectionRequest(bytes: Uint8Array): CollectionRequest {
  const raw = parseUnambiguousJson(bytes);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('INVALID_MESSAGE');
  const value = raw as Record<string, unknown>;
  if (value.version !== 1) return fail('UNSUPPORTED_VERSION');
  if (value.type !== 'status' && value.type !== 'capture') return fail('INVALID_MESSAGE');
  exactObject(value, value.type === 'status' ? ['version', 'type', 'requestId'] : ['version', 'type', 'requestId', 'captureId', 'snapshot'], 'INVALID_MESSAGE');
  const requestId = collectionId(value.requestId, 'INVALID_MESSAGE');
  return value.type === 'status' ? { version: 1, type: 'status', requestId } : { version: 1, type: 'capture', requestId, captureId: collectionId(value.captureId, 'INVALID_MESSAGE'), snapshot: validateCollectionSnapshot(value.snapshot) };
}

export function validateCollectionReceipt(raw: unknown): CollectionReceipt {
  const value = exactObject(raw, ['id', 'firstCaptureId', 'productId', 'fingerprint', 'receivedAt', 'snapshot', 'skuMappings']);
  const snapshot = validateCollectionSnapshot(value.snapshot), fingerprint = collectionFingerprint(snapshot);
  if (value.fingerprint !== fingerprint || JSON.stringify(snapshot) !== JSON.stringify(value.snapshot)) return fail();
  const skuMappings = list(value.skuMappings, 200).map(raw => { const item = exactObject(raw, ['providerSkuId', 'localVariantId']); return { providerSkuId: string(item.providerSkuId, 128), localVariantId: collectionId(item.localVariantId) }; });
  unique(skuMappings.map(item => item.providerSkuId)); unique(skuMappings.map(item => item.localVariantId));
  if (skuMappings.length !== snapshot.skus.length || skuMappings.some((item, index) => item.providerSkuId !== snapshot.skus[index].providerSkuId)) return fail();
  return { id: collectionId(value.id), firstCaptureId: collectionId(value.firstCaptureId), productId: collectionId(value.productId), fingerprint, receivedAt: timestamp(value.receivedAt), snapshot, skuMappings };
}
export function validateCollectionCapture(raw: unknown): CollectionCaptureRecord {
  const value = exactObject(raw, ['id', 'receiptId', 'fingerprint', 'capturedAt', 'receivedAt', 'duplicate']);
  if (typeof value.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(value.fingerprint) || typeof value.duplicate !== 'boolean') return fail();
  return { id: collectionId(value.id), receiptId: collectionId(value.receiptId), fingerprint: value.fingerprint, capturedAt: timestamp(value.capturedAt), receivedAt: timestamp(value.receivedAt), duplicate: value.duplicate };
}
