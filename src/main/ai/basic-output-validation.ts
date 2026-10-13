import type { AiOutput,ContentSuggestionOutput,TextReviewOutput,ContentReviewField,ContentReviewCheck } from '../../shared/ai-contracts.ts';
import { TEXT_REVIEW_POLICY_VERSION } from '../../shared/ai-contracts.ts';
import { keys,object,boundedText,integer,uuid,uuidList,sha256,invalid,MAX_OCR_TEXT } from './primitives.ts';
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
export function validateBasicOutput(raw:unknown):AiOutput {
  const kind=object(raw).kind;
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
