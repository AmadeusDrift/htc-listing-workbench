import { createHmac } from 'node:crypto';
import { parseUnambiguousJson } from '../collection/validation.ts';
import type { MiaoshouCredentials } from './vault.ts';
import { fail, MiaoshouError } from './validation.ts';

export const MIAOSHOU_ENDPOINT = 'https://openapi-erp.91miaoshou.com';
export const MIAOSHOU_PATHS = {
  list: '/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_list',
  detail: '/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_detail',
} as const;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DECIMAL_FIELDS = new Set(['price', 'oriPrice', 'stock', 'oriStock', 'weight', 'packageLength', 'packageWidth', 'packageHeight', 'minSkuPrice', 'maxSkuPrice']);
const INVALID_NUMBER_TOKEN = Object.freeze([]);
type SourceContext = { source?: string };
type LosslessJSON = typeof JSON & { rawJSON(source: string): unknown };

/** Expand a JSON numeric token as text. Only its bounded exponent is converted to Number. */
function exactNumberToken(source: string, id: boolean): string {
  if (source.length > 512) return fail('RESPONSE');
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source); if (!match) return fail('RESPONSE');
  const [, integer, fraction = '', rawExponent = '0'] = match;
  if (rawExponent.length > 4) return fail('RESPONSE'); const exponent = Number(rawExponent); if (Math.abs(exponent) > 256) return fail('RESPONSE');
  const digits = integer + fraction, point = integer.length + exponent;
  let whole: string, decimals: string;
  if (point <= 0) { whole = '0'; decimals = '0'.repeat(-point) + digits; }
  else if (point >= digits.length) { whole = digits + '0'.repeat(point - digits.length); decimals = ''; }
  else { whole = digits.slice(0, point); decimals = digits.slice(point); }
  whole = whole.replace(/^0+(?=\d)/, '');
  if (id) { if (whole.length > 128 || /[1-9]/.test(decimals)) return fail('RESPONSE'); return whole; }
  // Match snapshot bounds, including all original fractional trailing zeros; never round or truncate.
  if (whole.length > 18 || decimals.length > 18) return fail('RESPONSE');
  return whole + (decimals ? `.${decimals}` : '');
}
function parseResponse(bytes: Uint8Array): unknown {
  // Reuse the native boundary's duplicate-key, depth and fatal UTF-8 checks without changing it.
  // Its Number-valued result is discarded: context.source below supplies the original wire token.
  parseUnambiguousJson(bytes, MAX_RESPONSE_BYTES);
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(source, (key: string, value: unknown, context?: SourceContext) => {
    if (typeof value !== 'number' || key !== 'commonCollectBoxDetailId' && !DECIMAL_FIELDS.has(key)) return value;
    if (typeof context?.source !== 'string') return fail('RESPONSE');
    try { return exactNumberToken(context.source, key === 'commonCollectBoxDetailId'); }
    catch (error) {
      // These names can also occur in metadata that normalization deliberately discards.
      // An array cannot be accepted as a decimal, ID or SKU record; consumed invalid values
      // still fail validation, while ignored metadata does not block an otherwise valid product.
      if (error instanceof MiaoshouError) return INVALID_NUMBER_TOKEN;
      throw error;
    }
  });
}
function serializeBody(operation: keyof typeof MIAOSHOU_PATHS, body: Record<string, unknown>): string {
  return JSON.stringify(body, (key: string, value: unknown) => operation === 'detail' && key === 'commonCollectBoxDetailId' && typeof value === 'string' && /^(?:0|[1-9]\d{0,127})$/.test(value)
    ? (JSON as LosslessJSON).rawJSON(value) : value);
}
function aborted(signal: AbortSignal): void { if (signal.aborted) throw signal.reason instanceof MiaoshouError ? signal.reason : new MiaoshouError('NETWORK'); }
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof MiaoshouError ? signal.reason : new MiaoshouError('NETWORK'));
    if (signal.aborted) { promise.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
export async function readMiaoshou(operation: keyof typeof MIAOSHOU_PATHS, body: Record<string, unknown>, credentials: MiaoshouCredentials,
  transport: typeof fetch, now: Date, signal: AbortSignal): Promise<unknown> {
  let received: Response | undefined;
  try {
    aborted(signal); const path = MIAOSHOU_PATHS[operation]; if (!path) return fail('INPUT');
    const seconds = Math.floor(now.getTime() / 1000); if (!Number.isSafeInteger(seconds) || seconds < 0) return fail('INPUT');
    const timestamp = String(seconds), bodyJson = serializeBody(operation, body);
    const signature = createHmac('sha256', credentials.appSecret).update(credentials.appSecret + path + timestamp + credentials.appKey + bodyJson + credentials.appSecret).digest('hex');
    const pending = transport(MIAOSHOU_ENDPOINT + path, { method: 'POST', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal,
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-app-key': credentials.appKey, 'x-timestamp': timestamp, 'x-sign': signature }, body: bodyJson });
    const response = await abortable(pending.then(value => { if (signal.aborted) value.body?.cancel().catch(() => {}); return value; }), signal); received = response;
    aborted(signal);
    if (response.status === 401) return fail('AUTH'); if (response.status === 403) return fail('PERMISSION');
    if (response.status === 429) {
      const header = response.headers.get('retry-after')?.trim();
      const delay = header ? /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - now.getTime() : NaN;
      throw new MiaoshouError('LIMIT', { window: 'unknown',
        ...(Number.isFinite(delay) && delay >= 0 && delay <= Number.MAX_SAFE_INTEGER ? { retryAfterMs: delay } : {}),
      });
    }
    if (!response.ok || response.redirected || !response.body) return fail('RESPONSE');
    const length = Number(response.headers.get('content-length')); if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) return fail('TOO_LARGE');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const next = await abortable(reader.read(), signal); aborted(signal); if (next.done) break; size += next.value.byteLength; if (size > MAX_RESPONSE_BYTES) return fail('TOO_LARGE'); chunks.push(next.value); }
    } finally { reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch { /* The abort signal may still be settling an underlying read. */ } }
    const bytes = Buffer.concat(chunks, size);
    try { return parseResponse(bytes); } catch { return fail('RESPONSE'); }
  } catch (error) { aborted(signal); if (error instanceof MiaoshouError) throw error; return fail('NETWORK'); }
  finally { received?.body?.cancel().catch(() => {}); }
}
