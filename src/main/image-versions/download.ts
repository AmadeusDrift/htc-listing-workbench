import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { isPublicIp } from '../hosting/public-probe.ts';
import { ossImageUrl } from "../ai/basic-output-validation.ts";
import { AiError, abortable, throwIfAborted } from '../ai/errors.ts';
import { UserFacingError } from '../../shared/errors.ts';

export type ArtifactDownloader = (url: string, signal: AbortSignal) => Promise<Buffer>;
export interface DownloadDependencies {
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  request?: typeof httpsRequest; maxBytes?: number; timeoutMs?: number;
}
/** One bounded GET pinned to a public DNS answer. Signed query parameters are never logged. */
export function createArtifactDownloader(dependencies: DownloadDependencies = {}): ArtifactDownloader {
  const lookup = dependencies.lookup ?? (hostname => dnsLookup(hostname, { all: true }));
  const request = dependencies.request ?? httpsRequest, max = dependencies.maxBytes ?? 20 * 1024 * 1024;
  if (!Number.isSafeInteger(max) || max < 1 || max > 20 * 1024 * 1024) throw new Error('Invalid artifact download limit');
  return async (value, callerSignal) => {
    const url = new URL(ossImageUrl(value)); throwIfAborted(callerSignal);
    const controller = new AbortController(), cancel = () => controller.abort(new AiError('CANCELLED'));
    callerSignal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new AiError('TIMEOUT')), dependencies.timeoutMs ?? 30000), signal = controller.signal;
    try {
      const addresses = await abortable(lookup(url.hostname), signal);
      if (!addresses.length || addresses.some(a => !isPublicIp(a.address) || isIP(a.address) !== a.family)) throw new UserFacingError('图片成果地址未通过公网校验');
      const pinned = addresses[0], pinnedLookup: LookupFunction = (_host, options, callback) => {
        if (options.all) (callback as unknown as (error: null, results: typeof addresses) => void)(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      };
      throwIfAborted(signal);
      return await new Promise<Buffer>((resolve, reject) => {
        let settled = false; let req: ReturnType<typeof httpsRequest> | undefined;
        const finish = (error: Error | null, bytes?: Buffer) => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); if (error) reject(error); else resolve(bytes!); };
        const abort = () => { finish(signal.reason instanceof AiError ? signal.reason : new AiError('CANCELLED')); req?.destroy(); };
        signal.addEventListener('abort', abort, { once: true });
        try {
          req = request(url, { method: 'GET', agent: false, lookup: pinnedLookup, rejectUnauthorized: true, maxHeaderSize: 8192, headers: { Accept: 'image/png', 'Accept-Encoding': 'identity' } }, response => {
            const fail = (message: string) => { finish(new UserFacingError(message)); response.destroy(); req?.destroy(); };
            if (settled) { response.destroy(); return; }
            if (response.statusCode !== 200) { fail(response.statusCode === 403 || response.statusCode === 404 ? '图片成果链接已失效或不可访问，未重新调用抠图接口' : '图片成果下载未完成，未接受跳转或错误响应'); return; }
            const declared = response.headers['content-length'];
            if (String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'image/png' || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') || (declared !== undefined && (!/^\d+$/.test(String(declared)) || Number(declared) < 1 || Number(declared) > max))) { fail('图片成果格式或大小不符合要求'); return; }
            let size = 0; const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => { if (settled) return; size += chunk.length; if (size > max) { fail('图片成果超过大小限制'); return; } chunks.push(chunk); });
            response.once('error', () => finish(new UserFacingError('图片成果下载中断')));
            response.once('aborted', () => finish(new UserFacingError('图片成果下载中断')));
            response.once('end', () => {
              if (!size || (declared !== undefined && size !== Number(declared))) { fail('图片成果下载不完整'); return; }
              finish(null, Buffer.concat(chunks, size));
            });
          });
          req.once('error', () => finish(signal.aborted ? new AiError('CANCELLED') : new UserFacingError('图片成果网络请求未完成')));
          req.end(); if (signal.aborted) abort();
        } catch { finish(new UserFacingError('图片成果网络请求未完成')); req?.destroy(); }
      });
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof UserFacingError) throw error;
      throw new UserFacingError('图片成果下载未完成');
    } finally { clearTimeout(timer); callerSignal.removeEventListener('abort', cancel); }
  };
}
