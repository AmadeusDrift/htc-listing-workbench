import { LISTING_EVIDENCE_CONTRACT_VERSION } from '../../shared/listing-ai-contracts.ts';
import { assertListingEvidence } from '../listing-ai/validation.ts';
import { assertStoredListingEvidence } from '../listing-ai/stored-evidence.ts';
import { AI_PROVIDER_IDS, TEXT_REVIEW_POLICY_VERSION } from '../../shared/ai-contracts.ts';
import { AI_VENDOR_IDS } from '../../shared/ai-connection-contracts.ts';
import type { AiVendorId } from '../../shared/ai-connection-contracts.ts';
import type { AiCall, AiErrorCode, AiOutput, AiProfile, AiProviderId, AiResult, AiUsage, ContentReviewCheck, ContentReviewField, ContentSuggestionOutput, RecognizeImageInput, ReviewContentInput, SegmentImageInput, SuggestContentInput, TextReviewOutput } from '../../shared/ai-contracts.ts';
import { listingFingerprint, validateListingContext, validateListingFieldsOutput, validateListingReviewOutput } from '../listing-ai/validation.ts';
import { AI_ERROR_CODES, AiError } from './errors.ts';
import { assertCurrentListingReview, assertImagePlan, validateGeneratedImageOcr, validateImagePlan, validateImageTextReview, validateImageIpReview, validateListingCurrentReview, validateProductImageContext } from './image-validation.ts';
import { MAX_VISION_REQUEST_BYTES } from './vision.ts';
import { PRODUCT_IMAGE_POLICY_VERSION, imageCopySourceIds } from '../../shared/image-ai-contracts.ts';
import { validateCategoryDecision } from './category-adapter.ts';
import { assertSourceColorOutput, validateSourceColorContext, validateSourceColorOutput } from './source-color-validation.ts';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_OCR_TEXT = 100000;
export const MODELS = { 'aliyun-ocr': 'RecognizeAllText/Commerce', 'aidge-segmentation': 'ImageMatting', deepseek: 'deepseek-flash', 'deepseek-review': 'deepseek-v4-pro', 'aliyun-image-risk':'aigcViolationDetection' } as const;
export const CAPABILITIES = { 'aliyun-ocr': 'ocr', 'aidge-segmentation': 'segmentation', deepseek: 'text', 'deepseek-review': 'text-review', 'aliyun-image-risk':'image-risk' } as const;
export type DeepSeekModel = 'deepseek-flash' | 'deepseek-v4-pro';
export interface AliyunCredentials { accessKeyId: string; accessKeySecret: string; securityToken?: string }
export interface DeepSeekCredentials { apiKey: string }
export type AiCredentials = AliyunCredentials | DeepSeekCredentials;
export type ProfileImport = { id: 'aliyun-ocr' | 'aidge-segmentation' | 'aliyun-image-risk'; model: string; credentials: AliyunCredentials } | { id: 'deepseek' | 'deepseek-review'; model: DeepSeekModel; credentials: DeepSeekCredentials };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function invalid(code: AiErrorCode = 'INVALID_CONFIG'): never { throw new AiError(code); }
export function object(raw: unknown): Record<string, unknown> { if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) invalid(); return raw as Record<string, unknown>; }
export function keys(raw: unknown, names: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const o = object(raw);
  if (names.some(name => !Object.hasOwn(o, name)) || Object.keys(o).some(key => !names.includes(key) && !optional.includes(key))) invalid();
  return o;
}
export function providerId(raw: unknown): AiProviderId { if (typeof raw !== 'string' || !AI_PROVIDER_IDS.includes(raw as AiProviderId)) invalid('INVALID_INPUT'); return raw as AiProviderId; }
export function vendorId(raw: unknown): AiVendorId { if (typeof raw !== 'string' || !AI_VENDOR_IDS.includes(raw as AiVendorId)) invalid('INVALID_INPUT'); return raw as AiVendorId; }
export function uuid(raw: unknown): string { if (typeof raw !== 'string' || !UUID.test(raw)) invalid('INVALID_INPUT'); return raw; }
export function integer(raw: unknown, min: number, max: number): number { if (!Number.isSafeInteger(raw) || Number(raw) < min || Number(raw) > max) invalid(); return Number(raw); }
export function boundedText(raw: unknown, max: number, empty = false): string { if (typeof raw !== 'string' || raw.length > max || (!empty && !raw.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(raw)) invalid(); return raw; }
function flag(raw: unknown): boolean { if (typeof raw !== 'boolean') invalid(); return raw; }
export function date(raw: unknown): string { const value = boundedText(raw, 24); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(); return value; }
export function sha256(raw: unknown): string { if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw)) invalid(); return raw; }
export function uuidList(raw: unknown, max: number, min = 0): string[] {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max) invalid();
  const result = Array.from(raw, uuid); if (new Set(result).size !== result.length) invalid(); return result;
}
export function isDeepSeek(id: AiProviderId): id is 'deepseek' | 'deepseek-review' { return id === 'deepseek' || id === 'deepseek-review'; }
export function modelFor(id: AiProviderId, raw: unknown): string { if (typeof raw !== 'string' || (isDeepSeek(id) ? !['deepseek-flash', 'deepseek-v4-pro'].includes(raw) : raw !== MODELS[id])) invalid(); return raw; }
function secret(raw: unknown): string { const text = boundedText(raw, 4096); if (text.length < 8 || /[^\x21-\x7e]/.test(text)) invalid(); return text; }
export function parseProfileImport(raw: unknown): ProfileImport {
  const id = providerId(object(raw).id);
  const o = isDeepSeek(id) ? keys(raw, ['id', 'model', 'apiKey']) : keys(raw, ['id', 'accessKeyId', 'accessKeySecret'], ['securityToken']);
  const model = isDeepSeek(id) ? modelFor(id, o.model) : MODELS[id];
  const credentials: AiCredentials = isDeepSeek(id) ? { apiKey: secret(o.apiKey) } : { accessKeyId: secret(o.accessKeyId), accessKeySecret: secret(o.accessKeySecret), ...(o.securityToken === undefined || o.securityToken === '' ? {} : { securityToken: secret(o.securityToken) }) };
  if (Object.values(credentials).some(value => [id, model, CAPABILITIES[id]].some(publicValue => publicValue.includes(value)))) invalid();
  return { id, model, credentials } as ProfileImport;
}
export function parseConnectionInput(raw: unknown): { id: AiVendorId; credentials: AiCredentials } {
  const id = vendorId(object(raw).id);
  const o = id === 'deepseek' ? keys(raw, ['id', 'apiKey']) : keys(raw, ['id', 'accessKeyId', 'accessKeySecret'], ['securityToken']);
  const parsed = parseProfileImport(id === 'deepseek' ? { id, model: MODELS[id], apiKey: o.apiKey }
    : { id: 'aliyun-ocr', accessKeyId: o.accessKeyId, accessKeySecret: o.accessKeySecret, ...(o.securityToken === undefined ? {} : { securityToken: o.securityToken }) });
  return { id, credentials: parsed.credentials };
}
export function validateAiProfile(raw: unknown): AiProfile {
  const o = keys(raw, ['id', 'capability', 'model', 'enabled', 'configured', 'generation']), id = providerId(o.id);
  const enabled = flag(o.enabled), configured = flag(o.configured), generation = integer(o.generation, 0, Number.MAX_SAFE_INTEGER - 1);
  if (o.capability !== CAPABILITIES[id] || (enabled && !configured) || (configured && !generation)) invalid();
  return { id, capability: CAPABILITIES[id], model: modelFor(id, o.model), enabled, configured, generation };
}
export function validateUsage(raw: unknown): AiUsage {
  const o = keys(raw, ['promptTokens', 'completionTokens', 'processedImages']);
  return { promptTokens: integer(o.promptTokens, 0, 1000000000), completionTokens: integer(o.completionTokens, 0, 1000000000), processedImages: integer(o.processedImages, 0, 1000000) };
}
export function requestId(raw: unknown): string | null { if (raw === null || raw === undefined) return null; if (typeof raw !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(raw)) invalid(); return raw; }
export function validateAiCall(raw: unknown): AiCall {
  const o = keys(raw, ['id', 'providerId', 'productId', 'productRevision', 'status', 'errorCode', 'requestId', 'model', 'generation', 'startedAt', 'finishedAt', 'usage'], ['sourceColorContext']), id = providerId(o.providerId);
  if (typeof o.status !== 'string' || !['RUNNING', 'SUCCEEDED', 'FAILED'].includes(o.status) || (o.errorCode !== null && !AI_ERROR_CODES.includes(o.errorCode as AiErrorCode))) invalid();
  const startedAt = date(o.startedAt), finishedAt = o.finishedAt === null ? null : date(o.finishedAt);
  if ((o.status === 'RUNNING' && (finishedAt !== null || o.errorCode !== null)) || (o.status === 'SUCCEEDED' && (!finishedAt || o.errorCode !== null)) || (o.status === 'FAILED' && (!finishedAt || o.errorCode === null)) || (finishedAt && finishedAt < startedAt)) invalid();
  const sourceColorContext=o.sourceColorContext===undefined?undefined:validateSourceColorContext(o.sourceColorContext);
  if(sourceColorContext&&(id!=='deepseek'||o.model!=='deepseek-flash'||sourceColorContext.productId!==o.productId||sourceColorContext.productRevision!==o.productRevision))invalid();
  return { id: uuid(o.id), providerId: id, productId: uuid(o.productId), productRevision: integer(o.productRevision, 1, Number.MAX_SAFE_INTEGER), status: o.status as AiCall['status'], errorCode: o.errorCode as AiCall['errorCode'], requestId: requestId(o.requestId), model: modelFor(id, o.model), generation: integer(o.generation, 1, Number.MAX_SAFE_INTEGER - 1), startedAt, finishedAt, usage: validateUsage(o.usage), ...(sourceColorContext?{sourceColorContext}:{}) };
}
export function ossImageUrl(raw: unknown): string {
  const value = boundedText(raw, 8192);
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || url.hash || /[\s\\]/.test(value) || !/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]\.oss-(?:accelerate|[a-z]{2}-[a-z]+-\d|[a-z]{2}-[a-z]+)\.aliyuncs\.com$/.test(url.hostname) || url.pathname === '/') invalid();
    url.protocol = 'https:'; return url.href;
  } catch { return invalid(); }
}
const PROTECTED_ATTRIBUTE_WORDS = new Set([
  'id', 'ids', 'identifier', 'identifiers', 'identity', 'uuid', 'guid', 'barcode', 'barcodes',
  'brand', 'brands', 'branding', 'branded', 'manufacturer', 'manufacturers',
  'price', 'prices', 'pricing', 'cost', 'costs', 'currency', 'currencies', 'inventory', 'stock',
  'seller', 'sellers', 'merchant', 'merchants', 'account', 'accounts', 'credential', 'credentials', 'secret', 'secrets', 'token', 'tokens', 'password', 'passwords', 'auth', 'oauth', 'authorization', 'authentication',
  'compliance', 'compliant', 'certification', 'certifications', 'certificate', 'certificates', 'certified', 'hazard', 'hazards', 'hazardous', 'safety', 'regulation', 'regulations', 'regulatory', 'license', 'licence',
]);
const PROTECTED_ATTRIBUTE_COMPOUNDS = new Set([
  'brandname', 'manufacturername', 'manufacturerpartnumber', 'productid', 'itemid', 'externalproductid', 'externallyassignedproductidentifier', 'productidentifier', 'itemidentifier',
  'purchaseprice', 'purchasecost', 'buyingprice', 'buyprice', 'unitprice', 'unitcost', 'costprice', 'sellingprice', 'saleprice', 'salesprice', 'retailprice', 'wholesaleprice', 'listprice', 'standardprice', 'offerprice', 'recommendedprice',
  'stockquantity', 'inventoryquantity', 'sellerid', 'merchantid', 'accountid', 'apikey', 'accesskey', 'accesskeyid', 'accesskeysecret', 'clientid', 'clientsecret', 'securitytoken', 'refreshtoken',
  'fulfillmentavailability', 'purchasableoffer',
]);
const PROTECTED_ATTRIBUTE_PAIRS = new Set(['api key', 'access key', 'fulfillment availability', 'purchasable offer']);
export function protectedAttribute(name: string): boolean {
  const normalized = name.normalize('NFKC');
  // Chinese labels have no reliable word separators; use the known protected concepts and aliases.
  const compact = normalized.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  if (/商品编码|商品编号|产品编号|货号|条码|品牌|商标|制造商|生产商|厂商|厂牌|制造厂|生产厂|厂家|价格|采购|进货|购入|成本|售价|销售价|零售价|批发价|标价|定价|币种|货币|库存|账号|账户|卖家|商家|店铺|密钥|密码|口令|令牌|凭据|授权|认证|证书|合规|危险|安全标准/.test(compact)) return true;
  // Split snake_case, labels and camelCase while keeping acronyms (e.g. GTIN14 or upcCode) intact.
  const words = normalized.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z]+[0-9]*/g) ?? [];
  if (words.some(word => PROTECTED_ATTRIBUTE_WORDS.has(word) || /^(?:sku|asin|gtin|ean|upc|isbn|mpn)[0-9]*$/.test(word))) return true;
  return PROTECTED_ATTRIBUTE_COMPOUNDS.has(words.join('')) || words.some((word, index) => PROTECTED_ATTRIBUTE_PAIRS.has(`${word} ${words[index + 1] ?? ''}`));
}
export function validateTextOutput(raw: unknown): ContentSuggestionOutput {
  const o = keys(raw, ['kind', 'title', 'bullets', 'description', 'attributes']);
  if (o.kind !== 'text' || !Array.isArray(o.bullets) || o.bullets.length < 1 || o.bullets.length > 10 || !Array.isArray(o.attributes) || o.attributes.length > 50) invalid();
  const attributes = Array.from(o.attributes, raw => {
    const a = keys(raw, ['name', 'value', 'factIds']), name = boundedText(a.name, 100);
    if (protectedAttribute(name)) invalid();
    return { name, value: boundedText(a.value, 1000), factIds: uuidList(a.factIds, 20, 1) };
  });
  if (new Set(attributes.map(a => a.name.toLowerCase())).size !== attributes.length) invalid();
  return { kind: 'text', title: boundedText(o.title, 200), bullets: Array.from(o.bullets, b => boundedText(b, 500)), description: boundedText(o.description, 5000), attributes };
}
function reviewField(raw: unknown): ContentReviewField {
  if (typeof raw !== 'string' || !/^(?:title|description|bullets\.[0-9]|attributes\.(?:[0-9]|[1-4][0-9]))$/.test(raw)) invalid();
  return raw as ContentReviewField;
}
/** Structural validation is also used for saved reports and backups; live evidence is checked separately. */
export function validateTextReviewOutput(raw: unknown): TextReviewOutput {
  const o = keys(raw, ['kind', 'suggestionId', 'suggestionSha256', 'sourceSha256', 'policyVersion', 'verdict', 'checks', 'issues']);
  if (o.kind !== 'text-review' || o.policyVersion !== TEXT_REVIEW_POLICY_VERSION || !['PASS', 'NEEDS_CHANGES', 'BLOCKED'].includes(String(o.verdict)) || typeof o.verdict !== 'string' || !Array.isArray(o.checks) || o.checks.length < 3 || o.checks.length > 62 || !Array.isArray(o.issues) || o.issues.length > 100) invalid();
  const checks: ContentReviewCheck[] = Array.from(o.checks, raw => {
    const c = keys(raw, ['field', 'verdict', 'evidenceIds', 'reason']);
    if (typeof c.verdict !== 'string' || !['SUPPORTED', 'UNSUPPORTED', 'CONTRADICTED'].includes(c.verdict)) invalid();
    return { field: reviewField(c.field), verdict: c.verdict as ContentReviewCheck['verdict'], evidenceIds: uuidList(c.evidenceIds, 50, c.verdict === 'UNSUPPORTED' ? 0 : 1), reason: boundedText(c.reason, 2000) };
  });
  const fields = new Set(checks.map(c => c.field));
  if (fields.size !== checks.length || !fields.has('title') || !fields.has('description') || !fields.has('bullets.0')) invalid();
  for (const prefix of ['bullets', 'attributes'] as const) {
    const count = checks.filter(c => c.field.startsWith(`${prefix}.`)).length;
    for (let index = 0; index < count; index++) if (!fields.has(`${prefix}.${index}`)) invalid();
  }
  const issues = Array.from(o.issues, raw => {
    const i = keys(raw, ['code', 'field', 'message']), code = boundedText(i.code, 80), field = i.field === null ? null : reviewField(i.field);
    if (!/^[A-Z][A-Z0-9_]{0,79}$/.test(code) || (field !== null && !fields.has(field))) invalid();
    return { code, field, message: boundedText(i.message, 2000) };
  });
  if (o.verdict === 'PASS' ? (issues.length > 0 || checks.some(c => c.verdict !== 'SUPPORTED')) : issues.length === 0) invalid();
  return { kind: 'text-review', suggestionId: uuid(o.suggestionId), suggestionSha256: sha256(o.suggestionSha256), sourceSha256: sha256(o.sourceSha256), policyVersion: TEXT_REVIEW_POLICY_VERSION, verdict: o.verdict as TextReviewOutput['verdict'], checks, issues };
}
export function validateOutput(raw: unknown): AiOutput {
  const kind = object(raw).kind;
  if (kind === 'source-color') return validateSourceColorOutput(raw);
  if (kind === 'category-decision') return validateCategoryDecision(raw);
  if (kind === 'image-plan') return validateImagePlan(raw);
  if (kind === 'generated-image-ocr') return validateGeneratedImageOcr(raw);
  if (kind === 'image-text-review') return validateImageTextReview(raw);
  if (kind === 'image-ip-review') return validateImageIpReview(raw);
  if (kind === 'listing-current-review') return validateListingCurrentReview(raw);
  if (kind === 'amazon-fields') return validateListingFieldsOutput(raw);
  if (kind === 'amazon-fields-review') return validateListingReviewOutput(raw);
  if (kind === 'text') return validateTextOutput(raw);
  if (kind === 'text-review') return validateTextReviewOutput(raw);
  if (kind === 'ocr') {
    const o = keys(raw, ['kind', 'text', 'lines', 'width', 'height', 'coordinateSpace']);
    if (o.coordinateSpace !== 'unknown' || !Array.isArray(o.lines) || o.lines.length > 5000) invalid();
    const lines = Array.from(o.lines, raw => { const line = keys(raw, ['text', 'confidence', 'box']); if (line.box !== null || (line.confidence !== null && (typeof line.confidence !== 'number' || !Number.isFinite(line.confidence) || line.confidence < 0 || line.confidence > 1))) invalid(); return { text: boundedText(line.text, 10000, true), confidence: line.confidence as number | null, box: null }; });
    const text = boundedText(o.text, MAX_OCR_TEXT, true), width = integer(o.width, 16, 8191), height = integer(o.height, 16, 8191);
    if (lines.reduce((n, l) => n + l.text.length, 0) > MAX_OCR_TEXT || Boolean(text.trim()) !== lines.some(line => Boolean(line.text.trim())) || Math.max(width, height) / Math.min(width, height) >= 50) invalid();
    // Preserve the legacy guard without requiring provider summary grouping to equal the blocks.
    if (/\p{Script=Han}/u.test(text) && !lines.some(line => /\p{Script=Han}/u.test(line.text))) invalid();
    return { kind, text, lines, width, height, coordinateSpace: 'unknown' };
  }
  if (kind === 'segmentation') {
    const o = keys(raw, ['kind', 'outputKind', 'imageUrl', 'width', 'height', 'score', 'materialized']);
    if (o.outputKind !== 'transparent-cutout' || o.materialized !== false || (o.score !== null && (typeof o.score !== 'number' || !Number.isFinite(o.score) || o.score < 0 || o.score > 1000000))) invalid();
    return { kind, outputKind: 'transparent-cutout', imageUrl: ossImageUrl(o.imageUrl), width: integer(o.width, 256, 3000), height: integer(o.height, 256, 3000), score: o.score as number | null, materialized: false };
  }
  return invalid();
}
export function validateAiResult(raw: unknown, options:{stored?:boolean}={}): AiResult {
  const o = keys(raw, ['id', 'callId', 'providerId', 'productId', 'productRevision', 'variantId', 'assetId', 'assetSha256', 'sourceResultIds', 'model', 'createdAt', 'reviewState', 'output'], ['listingEvidenceContractVersion', 'sourceSha256', 'listingContext', 'listingRequestBytes', 'imageContext', 'imageRequestBytes', 'sourceColorContext', 'sourceColorRequestBytes']), id = providerId(o.providerId), output = validateOutput(o.output);
  const variantId = o.variantId === null ? null : uuid(o.variantId), assetId = o.assetId === null ? null : uuid(o.assetId), sourceResultIds = uuidList(o.sourceResultIds, 10);
  const assetSha256 = o.assetSha256 === null ? null : boundedText(o.assetSha256, 64);
  const listingKind = output.kind === 'amazon-fields' || output.kind === 'amazon-fields-review' || output.kind === 'listing-current-review';
  const imageKind = output.kind === 'image-plan' || output.kind === 'generated-image-ocr' || output.kind === 'image-text-review' || output.kind === 'image-ip-review';
  const expectedProvider = output.kind === 'source-color' ? 'deepseek' : output.kind === 'category-decision' ? output.phase === 'judge' ? 'deepseek-review' : 'deepseek' : imageKind ? output.kind === 'image-plan' ? 'deepseek' : output.kind === 'generated-image-ocr' ? 'aliyun-ocr' : output.kind === 'image-ip-review' ? 'aliyun-image-risk' : 'deepseek-review' : listingKind ? output.kind === 'amazon-fields' ? 'deepseek' : 'deepseek-review' : null;
  if (o.reviewState !== 'unreviewed' || (expectedProvider ? id !== expectedProvider : output.kind !== CAPABILITIES[id]) || (assetSha256 !== null && !/^[a-f0-9]{64}$/.test(assetSha256))) invalid();
  if (isDeepSeek(id) || imageKind ? (!variantId || assetId !== null || assetSha256 !== null) : (variantId !== null || !assetId || !assetSha256 || sourceResultIds.length)) invalid();
  if (o.sourceSha256 !== undefined && id !== 'deepseek' && !listingKind && !imageKind && output.kind !== 'category-decision') invalid();
  if (output.kind === 'text-review' && (sourceResultIds.length !== 1 || sourceResultIds[0] !== output.suggestionId)) invalid();
  if(o.listingEvidenceContractVersion!==undefined&&(!(listingKind||imageKind)||o.listingEvidenceContractVersion!==LISTING_EVIDENCE_CONTRACT_VERSION))invalid();
  const evidenceOptions=options.stored?{storedVersion:o.listingEvidenceContractVersion as string??null}:{};
  const listingContext = listingKind ? validateListingContext(o.listingContext) : undefined;
  if (!listingKind && (o.listingContext !== undefined || o.listingRequestBytes !== undefined)) invalid();
  if (listingContext && (listingContext.productId !== o.productId || listingContext.productRevision !== o.productRevision || listingContext.variantId !== variantId || listingFingerprint(listingContext) !== o.sourceSha256 || sourceResultIds.length !== (output.kind === 'amazon-fields-review' ? 1 : 0))) invalid();
  if (listingContext && output.kind === 'listing-current-review') assertCurrentListingReview({ kind: 'amazon-fields-review', verdict: output.verdict, checks: output.checks, issues: output.issues }, output.currentListingCopy, listingContext,options.stored?{storedVersion:o.listingEvidenceContractVersion as string??null}:{});
  if(listingContext&&output.kind==='amazon-fields'){if(options.stored)assertStoredListingEvidence(output,listingContext,o.listingEvidenceContractVersion as string|undefined);else assertListingEvidence(output,listingContext);}
  const imageContext = imageKind ? validateProductImageContext(o.imageContext,evidenceOptions) : undefined;
  if (!imageKind && (o.imageContext !== undefined || o.imageRequestBytes !== undefined)) invalid();
  if (imageContext) {
    const copySources = imageCopySourceIds(imageContext), offset = copySources.length;
    if (imageContext.listing.productId !== o.productId || imageContext.listing.productRevision !== o.productRevision || imageContext.listing.variantId !== variantId || listingFingerprint(imageContext) !== o.sourceSha256 || copySources.some((id,index) => sourceResultIds[index] !== id)) invalid();
    if (output.kind === 'image-plan') { if (sourceResultIds.length < offset || sourceResultIds.length > offset + 1) invalid(); assertImagePlan(output, imageContext,evidenceOptions); }
    if (output.kind === 'generated-image-ocr' && sourceResultIds.length !== offset) invalid();
    if (output.kind === 'image-ip-review' && (sourceResultIds.length!==offset+1 || sourceResultIds[offset]!==output.planResultId || imageContext.policyVersion!==PRODUCT_IMAGE_POLICY_VERSION))invalid();
    if (output.kind === 'image-text-review' && (sourceResultIds.length !== offset + 2 || sourceResultIds[offset] !== output.planResultId || sourceResultIds[offset+1] !== output.ocrResultId)) invalid();
  }
  if (imageContext && imageContext.policyVersion !== 'product-image/v1' && output.kind === 'image-plan' && o.model !== 'deepseek-flash') invalid();
  const sourceColorContext=output.kind==='source-color'?validateSourceColorContext(o.sourceColorContext):undefined;
  if(output.kind!=='source-color'&&(o.sourceColorContext!==undefined||o.sourceColorRequestBytes!==undefined))invalid();
  if(sourceColorContext&&output.kind==='source-color'){
    if(o.model!=='deepseek-flash'||sourceResultIds.length||sourceColorContext.productId!==o.productId||sourceColorContext.productRevision!==o.productRevision||sourceColorContext.variantId!==variantId||listingFingerprint(sourceColorContext)!==o.sourceSha256)invalid();
    assertSourceColorOutput(output,sourceColorContext);
  }
  return { id: uuid(o.id), callId: uuid(o.callId), providerId: id, productId: uuid(o.productId), productRevision: integer(o.productRevision, 1, Number.MAX_SAFE_INTEGER), variantId, assetId, assetSha256, sourceResultIds, model: modelFor(id, o.model), createdAt: date(o.createdAt), reviewState: 'unreviewed', output, ...(o.sourceSha256 === undefined ? {} : { sourceSha256: sha256(o.sourceSha256) }), ...(listingContext ? { listingContext, ...(o.listingEvidenceContractVersion===undefined?{}:{listingEvidenceContractVersion:LISTING_EVIDENCE_CONTRACT_VERSION}), ...(o.listingRequestBytes===undefined?{}:{listingRequestBytes:integer(o.listingRequestBytes,1,1024*1024)}) } : {}), ...(imageContext ? { imageContext, ...(o.listingEvidenceContractVersion===undefined?{}:{listingEvidenceContractVersion:LISTING_EVIDENCE_CONTRACT_VERSION}), imageRequestBytes: integer(o.imageRequestBytes, 1, MAX_VISION_REQUEST_BYTES) } : {}), ...(sourceColorContext?{sourceColorContext,sourceColorRequestBytes:integer(o.sourceColorRequestBytes,1,MAX_VISION_REQUEST_BYTES)}:{}) };
}
function parseInput<T>(operation: () => T): T { try { return operation(); } catch { throw new AiError('INVALID_INPUT'); } }
export function parseRecognizeInput(raw: unknown): RecognizeImageInput { return parseInput(() => { const o = keys(raw, ['productId', 'productRevision', 'assetId']); return { productId: uuid(o.productId), productRevision: integer(o.productRevision, 1, Number.MAX_SAFE_INTEGER), assetId: uuid(o.assetId) }; }); }
export function parseSegmentInput(raw: unknown): SegmentImageInput { return parseInput(() => { const o = keys(raw, ['productId', 'productRevision', 'assetId', 'hostedAssetId']); return { productId: uuid(o.productId), productRevision: integer(o.productRevision, 1, Number.MAX_SAFE_INTEGER), assetId: uuid(o.assetId), hostedAssetId: uuid(o.hostedAssetId) }; }); }
export function parseSuggestInput(raw: unknown): SuggestContentInput { return parseInput(() => { const o = keys(raw, ['productId', 'productRevision', 'variantId', 'ocrResultIds']); return { productId: uuid(o.productId), productRevision: integer(o.productRevision, 1, Number.MAX_SAFE_INTEGER), variantId: uuid(o.variantId), ocrResultIds: uuidList(o.ocrResultIds, 10) }; }); }
export function parseReviewInput(raw: unknown): ReviewContentInput { return parseInput(() => { const o = keys(raw, ['productId', 'productRevision', 'suggestionResultId']); return { productId: uuid(o.productId), productRevision: integer(o.productRevision, 1, Number.MAX_SAFE_INTEGER), suggestionResultId: uuid(o.suggestionResultId) }; }); }

/** Persistence readers validate the original contract, never authorize a new action. */
export const validateStoredAiResult=(raw:unknown):AiResult=>validateAiResult(raw,{stored:true});
