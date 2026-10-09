import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createArtifactDownloader } from '../src/main/image-versions/download.ts';

const url = 'https://output.oss-cn-beijing.aliyuncs.com/a.png?Signature=temporary';
test('artifact download rejects non-OSS and private DNS before any socket opens', async () => {
  let sockets = 0;
  const download = createArtifactDownloader({ lookup: async () => [{ address: '127.0.0.1', family: 4 }], request: (() => { sockets++; }) as never });
  await assert.rejects(download(url, new AbortController().signal));
  await assert.rejects(download('https://example.com/a.png', new AbortController().signal));
  assert.equal(sockets, 0);
});
test('artifact GET pins DNS and rejects redirects, encoding, malformed sizes and bounded overflow', async () => {
  let pinned = false;
  const make = (status: number, body: Buffer, headers: Record<string, string> = {}) => createArtifactDownloader({
    lookup: async () => [{ address: '8.8.8.8', family: 4 }], maxBytes: 64,
    request: ((_url: URL, options: { lookup: (host: string, options: unknown, callback: (...args: unknown[]) => void) => void }, cb: (response: Readable) => void) => {
      options.lookup('output.oss-cn-beijing.aliyuncs.com', {}, (_error, address) => { pinned = address === '8.8.8.8'; });
      const response = Object.assign(Readable.from([body]), { statusCode: status, headers: { 'content-type': 'image/png', ...headers } });
      return Object.assign(new EventEmitter(), { end() { queueMicrotask(() => cb(response)); }, destroy() {} });
    }) as never,
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await make(200, Buffer.from('PNG'))(url, signal), Buffer.from('PNG')); assert.ok(pinned);
  for (const [status, bytes, headers] of [[302, Buffer.from('PNG'), {}], [403, Buffer.from('PNG'), {}], [200, Buffer.alloc(65), {}], [200, Buffer.from('PNG'), { 'content-encoding': 'gzip' }], [200, Buffer.from('PNG'), { 'content-length': '50' }], [200, Buffer.from('PNG'), { 'content-type': 'text/html' }]] as const) await assert.rejects(make(status, bytes, headers)(url, signal));
});
test('artifact download cancellation settles even while DNS is pending', async () => {
  const controller = new AbortController(), download = createArtifactDownloader({ lookup: () => new Promise(() => {}) });
  const pending = download(url, controller.signal); controller.abort(); await assert.rejects(pending);
});
