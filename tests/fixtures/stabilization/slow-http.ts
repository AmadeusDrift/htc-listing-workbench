import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Real loopback bytes and server-owned counts; never contacts a supplier. */
export async function slowHttp(options: { body: string; delayMs?: number; headersDelayMs?: number; partial?: string; disconnect?: boolean; status?: number; contentLength?: string }) {
  let posts = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const delay = (work: () => void, ms: number) => { const timer = setTimeout(() => { timers.delete(timer); work(); }, ms); timers.add(timer); };
  const server = createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    posts++; req.resume();
    delay(() => {
      if (res.destroyed) return;
      res.writeHead(options.status ?? 200, { 'content-type': 'application/json', 'connection': 'close', ...(options.contentLength ? { 'content-length': options.contentLength } : {}) });
      res.flushHeaders();
      if (options.partial) res.write(options.partial);
      delay(() => { if (options.disconnect) res.destroy(); else res.end(options.body); }, options.delayMs ?? 0);
    }, options.headersDelayMs ?? 0);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    get posts() { return posts; },
    async close() { for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
