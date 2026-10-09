import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { isPublicIp } from '../hosting/public-probe.ts';
import { AiError, abortable, throwIfAborted } from '../ai/errors.ts';
import { unsupportedRelayJpeg, invalidImageOutput } from './errors.ts';

export interface RelayDownloadDependencies {
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  /** Electron net.fetch; never used for arbitrary URLs or ordinary public DNS. */
  nativeFetch?: (url: string, init: RequestInit) => Promise<Response>;
  request?: typeof httpsRequest; maxBytes?: number; timeoutMs?: number;
}
function publicImageUrl(value: string): URL {
  try {
    const url = new URL(value), hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (value.length > 4096 || url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || /[\x00-\x20\x7f\\]/.test(value)
      || (isIP(hostname) ? !isPublicIp(hostname) : !hostname.includes('.') || /\.(localhost|local|internal|home|lan)$/i.test(hostname) || hostname.endsWith('.'))) throw new Error();
    return url;
  } catch { throw invalidImageOutput('download'); }
}
function fakeIpv4(address: { address: string; family: number }): boolean {
  if (address.family !== 4 || isIP(address.address) !== 4) return false;
  const [first, second] = address.address.split('.').map(Number);
  return first === 198 && (second === 18 || second === 19);
}
async function nativeRelayImage(url: URL, signal: AbortSignal, max: number, fetcher: NonNullable<RelayDownloadDependencies['nativeFetch']>): Promise<Buffer> {
  throwIfAborted(signal);
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const pending = fetcher(url.href, { method: 'GET', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal,
      headers: { Accept: 'image/png', 'Accept-Encoding': 'identity' } }).then(value => {
      response = value;
      if (signal.aborted) { void value.body?.cancel().catch(() => {}); throwIfAborted(signal); }
      return value;
    });
    response = await abortable(pending, signal);
    throwIfAborted(signal);
    if (response.status !== 200 || response.redirected || (response.url && response.url !== url.href)) throw invalidImageOutput('download');
    const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(), length = response.headers.get('content-length'), encoding = response.headers.get('content-encoding');
    if (mime === 'image/jpeg') throw unsupportedRelayJpeg();
    if (mime !== 'image/png' || (encoding && encoding !== 'identity') || (length !== null && (!/^\d+$/.test(length) || Number(length) < 1 || Number(length) > max)) || !response.body) throw invalidImageOutput('download');
    reader = response.body.getReader();
    const chunks: Buffer[] = []; let size = 0;
    while (true) {
      const next = await abortable(reader.read(), signal); throwIfAborted(signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > max) throw invalidImageOutput('download');
      chunks.push(Buffer.from(next.value));
    }
    if (!size || (length !== null && size !== Number(length))) throw invalidImageOutput('download');
    return Buffer.concat(chunks, size);
  } finally {
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    else void response?.body?.cancel().catch(() => {});
  }
}
/** Bounded HTTPS GET: public DNS is pinned, or the exact Tyai origin uses its proxy's Fake-IP mapping. */
export function createRelayImageDownloader(deps: RelayDownloadDependencies = {}): (url: string, signal: AbortSignal) => Promise<Buffer> {
  const lookup = deps.lookup ?? (hostname => dnsLookup(hostname, { all: true })), request = deps.request ?? httpsRequest;
  const max = deps.maxBytes ?? 20 * 1024 * 1024, timeout = deps.timeoutMs ?? 60000;
  if (!Number.isSafeInteger(max) || max < 1 || max > 20 * 1024 * 1024 || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 660000) throw new AiError('INVALID_CONFIG');
  return async (value, callerSignal) => {
    throwIfAborted(callerSignal); const url = publicImageUrl(value), controller = new AbortController(), signal = controller.signal;
    const cancel = () => controller.abort(callerSignal.reason instanceof AiError ? callerSignal.reason : new AiError('CANCELLED'));
    callerSignal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new AiError('TIMEOUT')), timeout);
    try {
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await abortable(lookup(hostname), signal);
      // This exception is deliberately narrower than the general public-image URL support.
      if (deps.nativeFetch && hostname === 'tyaiapi.com' && addresses.length && addresses.every(fakeIpv4)) return await nativeRelayImage(url, signal, max, deps.nativeFetch);
      if (!addresses.length || addresses.some(address => !isPublicIp(address.address) || isIP(address.address) !== address.family)) throw invalidImageOutput('download');
      const pinned = addresses[0], pinnedLookup: LookupFunction = (_hostname, options, callback) => {
        if (options.all) (callback as unknown as (error: null, results: typeof addresses) => void)(null, [pinned]); else callback(null, pinned.address, pinned.family);
      };
      throwIfAborted(signal);
      return await new Promise<Buffer>((resolve, reject) => {
        let settled = false, req: ReturnType<typeof httpsRequest> | undefined;
        const finish = (error: AiError | null, bytes?: Buffer) => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); if (error) reject(error); else resolve(bytes!); };
        const abort = () => { finish(signal.reason instanceof AiError ? signal.reason : new AiError('CANCELLED')); req?.destroy(); };
        signal.addEventListener('abort', abort, { once: true });
        try {
          req = request(url, { method: 'GET', agent: false, lookup: pinnedLookup, rejectUnauthorized: true, maxHeaderSize: 8192,
            headers: { Accept: 'image/png', 'Accept-Encoding': 'identity' } }, response => {
            if (settled) { response.destroy(); return; }
            const fail = (error = invalidImageOutput('download')) => { finish(error); response.destroy(); req?.destroy(); };
            const length = response.headers['content-length'], mimeType = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
            if (response.statusCode === 200 && mimeType === 'image/jpeg') { fail(unsupportedRelayJpeg()); return; }
            if (response.statusCode !== 200 || mimeType !== 'image/png' || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')
              || (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) < 1 || Number(length) > max))) { fail(); return; }
            const chunks: Buffer[] = []; let size = 0;
            response.on('data', (chunk: Buffer) => { if (settled) return; size += chunk.length; if (size > max) { fail(); return; } chunks.push(chunk); });
            response.once('error', () => finish(new AiError('NETWORK_ERROR')));
            response.once('aborted', () => finish(new AiError('NETWORK_ERROR')));
            response.once('end', () => {
              if (settled) return;
              if (!size || (length !== undefined && size !== Number(length))) { fail(); return; }
              finish(null, Buffer.concat(chunks, size));
            });
          });
          req.once('error', () => finish(signal.aborted && signal.reason instanceof AiError ? signal.reason : new AiError('NETWORK_ERROR')));
          req.end(); if (signal.aborted) abort();
        } catch { finish(new AiError('NETWORK_ERROR')); req?.destroy(); }
      });
    } catch (error) { throwIfAborted(signal); throw error instanceof AiError ? error : new AiError('NETWORK_ERROR'); }
    finally { clearTimeout(timer); callerSignal.removeEventListener('abort', cancel); }
  };
}
