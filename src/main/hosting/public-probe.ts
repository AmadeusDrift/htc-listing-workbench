import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { createHash } from 'node:crypto';
import { HostingError, abortable, throwIfAborted } from './errors.ts';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const blockedV4 = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blockedV4.addSubnet(network, prefix, 'ipv4');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new BlockList();
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blockedV6.addSubnet(network, prefix, 'ipv6');
export function isPublicIp(address: string): boolean {
  if (isIP(address) === 4) return !blockedV4.check(address, 'ipv4');
  return isIP(address) === 6 && globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
}
export function validatePublicUrl(value: string): URL {
  let url: URL; try { url = new URL(value); } catch { throw new HostingError('PUBLIC_URL_UNSAFE'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (value.length > 3000 || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443') || !host || /[\x00-\x20\x7f\\]/.test(value)) throw new HostingError('PUBLIC_URL_UNSAFE');
  if (isIP(host) ? !isPublicIp(host) : (!host.includes('.') || /\.(localhost|local|internal|home|lan)$/i.test(host) || host.endsWith('.'))) throw new HostingError('PUBLIC_URL_UNSAFE');
  return url;
}
export interface PublicImageExpectation { url: string; sha256: string; byteSize: number; mimeType: string }
export type PublicImageProbe = (expected: PublicImageExpectation, signal: AbortSignal) => Promise<void>;
export interface PublicProbeDependencies {
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  request?: typeof httpsRequest;
  /** Electron net.fetch, limited to the existing company image domain's Fake-IP mapping. */
  nativeFetch?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}
function fakeIpv4(address: { address: string; family: number }): boolean {
  if (address.family !== 4 || isIP(address.address) !== 4) return false;
  const [first, second] = address.address.split('.').map(Number);
  return first === 198 && (second === 18 || second === 19);
}
async function probeCompanyImage(expected: PublicImageExpectation, signal: AbortSignal, fetcher: NonNullable<PublicProbeDependencies['nativeFetch']>): Promise<void> {
  let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    response = await abortable<Response>(fetcher(expected.url, { method: 'GET', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal,
      headers: { Accept: expected.mimeType, 'Accept-Encoding': 'identity' } }).then(value => {
      if (signal.aborted) { void value.body?.cancel().catch(() => {}); throwIfAborted(signal); }
      return value;
    }), signal);
    throwIfAborted(signal);
    if (response.redirected || (response.url && response.url !== expected.url)) throw new HostingError('PUBLIC_URL_UNSAFE');
    if (response.status !== 200) throw new HostingError(response.status === 404 ? 'PUBLIC_URL_NOT_FOUND' : response.status >= 500 || response.status === 429 ? 'PUBLIC_URL_UNAVAILABLE' : 'PUBLIC_URL_UNSAFE');
    const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(), length = response.headers.get('content-length'), encoding = response.headers.get('content-encoding');
    if (mime !== expected.mimeType || (encoding && encoding !== 'identity') || (length !== null && (!/^\d+$/.test(length) || Number(length) !== expected.byteSize)) || !response.body) throw new HostingError('PUBLIC_URL_CONTENT_MISMATCH');
    reader = response.body.getReader();
    const hash = createHash('sha256'); let size = 0;
    while (true) {
      const chunk = await abortable(reader.read(), signal); throwIfAborted(signal);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > expected.byteSize || size > MAX_IMAGE_BYTES) throw new HostingError('PUBLIC_URL_CONTENT_MISMATCH');
      hash.update(chunk.value);
    }
    if (size !== expected.byteSize || hash.digest('hex') !== expected.sha256) throw new HostingError('PUBLIC_URL_CONTENT_MISMATCH');
  } finally {
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    else void response?.body?.cancel().catch(() => {});
  }
}
/** One full GET with strict content verification; only the fixed company origin may use its Fake-IP proxy. */
export function createPublicImageProbe(dependencies: PublicProbeDependencies = {}): PublicImageProbe {
  const lookup = dependencies.lookup ?? (hostname => dnsLookup(hostname, { all: true }));
  const request = dependencies.request ?? httpsRequest;
  return async (expected, callerSignal) => {
    const url = validatePublicUrl(expected.url);
    if (!Number.isSafeInteger(expected.byteSize) || expected.byteSize < 1 || expected.byteSize > MAX_IMAGE_BYTES || !/^[a-f0-9]{64}$/.test(expected.sha256) || !['image/png', 'image/jpeg'].includes(expected.mimeType)) throw new HostingError('PUBLIC_URL_CONTENT_MISMATCH');
    throwIfAborted(callerSignal);
    const controller = new AbortController();
    const cancel = () => controller.abort(callerSignal.reason instanceof HostingError ? callerSignal.reason : new HostingError('CANCELLED'));
    callerSignal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new HostingError('PUBLIC_URL_TIMEOUT')), dependencies.timeoutMs ?? 15000);
    const signal = controller.signal;
    try {
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await abortable(lookup(hostname), signal);
      if (dependencies.nativeFetch && hostname === 'htc.185858.xyz' && /^\/(AAA|BBB|CCC|DDD|EEE)\//.test(url.pathname) && addresses.length && addresses.every(fakeIpv4)) {
        return await probeCompanyImage(expected, signal, dependencies.nativeFetch);
      }
      if (!addresses.length || addresses.some(result => !isPublicIp(result.address) || isIP(result.address) !== result.family)) throw new HostingError('PUBLIC_URL_UNSAFE');
      const pinned = addresses[0];
      const pinnedLookup: LookupFunction = (_host, options, callback) => {
        if (options.all) (callback as unknown as (error: null, addresses: Array<{ address: string; family: number }>) => void)(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      };
      throwIfAborted(signal);
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let req: ReturnType<typeof httpsRequest>;
        const finish = (error?: HostingError) => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); if (error) reject(error); else resolve(); };
        const abort = () => { const error = signal.reason instanceof HostingError ? signal.reason : new HostingError('CANCELLED'); finish(error); req?.destroy(); };
        signal.addEventListener('abort', abort, { once: true });
        try {
          req = request(url, { method: 'GET', agent: false, lookup: pinnedLookup, rejectUnauthorized: true, maxHeaderSize: 8192,
            headers: { Accept: expected.mimeType, 'Accept-Encoding': 'identity' } }, response => {
            const status = response.statusCode ?? 0;
            const fail = (error: HostingError) => { finish(error); response.destroy(); req.destroy(); };
            if (status !== 200) { fail(new HostingError(status === 404 ? 'PUBLIC_URL_NOT_FOUND' : status >= 500 || status === 429 ? 'PUBLIC_URL_UNAVAILABLE' : 'PUBLIC_URL_UNSAFE')); return; }
            const mime = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
            const declared = response.headers['content-length'];
            if (mime !== expected.mimeType || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') || (declared !== undefined && (!/^\d+$/.test(String(declared)) || Number(declared) !== expected.byteSize))) { fail(new HostingError('PUBLIC_URL_CONTENT_MISMATCH')); return; }
            const hash = createHash('sha256'); let bytes = 0;
            response.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > MAX_IMAGE_BYTES || bytes > expected.byteSize) { fail(new HostingError('PUBLIC_URL_CONTENT_MISMATCH')); return; }
              hash.update(chunk);
            });
            response.once('error', () => finish(new HostingError('PUBLIC_URL_UNAVAILABLE')));
            response.once('aborted', () => finish(new HostingError('PUBLIC_URL_UNAVAILABLE')));
            response.once('end', () => {
              if (settled) return;
              finish(bytes === expected.byteSize && hash.digest('hex') === expected.sha256 ? undefined : new HostingError('PUBLIC_URL_CONTENT_MISMATCH'));
            });
          });
          req.once('error', () => finish(signal.aborted && signal.reason instanceof HostingError ? signal.reason : new HostingError('PUBLIC_URL_UNAVAILABLE')));
          req.end();
          if (signal.aborted) abort();
        } catch { finish(new HostingError('PUBLIC_URL_UNAVAILABLE')); }
      });
    } catch (error) { if (error instanceof HostingError) throw error; throw new HostingError('PUBLIC_URL_UNAVAILABLE'); }
    finally { clearTimeout(timer); callerSignal.removeEventListener('abort', cancel); }
  };
}
