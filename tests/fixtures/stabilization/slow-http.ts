import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// WHATWG Fetch 2.9, checked 2026-10-15 against Node 24.21.0 / bundled Undici 7.29.1.
// OS-assigned port 0 can resolve to a fetch-blocked port on this Windows host.
const fetchBadPorts=new Set([0,1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,101,102,103,104,109,110,111,113,115,117,119,123,135,137,139,143,161,179,389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,563,587,601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,4190,5060,5061,6000,6566,6665,6666,6667,6668,6669,6679,6697,10080]);

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
  let port=0;
  for(let attempt=0;attempt<8;attempt++){
    await new Promise<void>((resolve,reject)=>{
      const onError=(error:Error)=>{server.off('listening',onReady);reject(error);};
      const onReady=()=>{server.off('error',onError);resolve();};
      server.once('error',onError);server.once('listening',onReady);server.listen(0,'127.0.0.1');
    });
    port=(server.address() as AddressInfo).port;
    if(!fetchBadPorts.has(port))break;
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    port=0;
  }
  if(!port)throw Error('STABILIZATION_FETCH_SAFE_PORT_UNAVAILABLE');
  return {
    url: `http://127.0.0.1:${port}`,
    get posts() { return posts; },
    async close() { for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
