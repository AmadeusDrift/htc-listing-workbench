import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('guard catches real Node outbound paths before initialization; unguarded control reaches only a local server', async t => {
  const guard = fileURLToPath(new URL('../scripts/release-network-guard.cjs', import.meta.url));
  assert.ok(existsSync(guard), 'isolated runtime must install an outbound guard before main');
  let received = 0; const server = createServer((_req, response) => { received++; response.end('local-control'); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => server.close(() => done())));
  const address = server.address(); assert.ok(address && typeof address === 'object'); const endpoint = `http://127.0.0.1:${address.port}`;
  const run = promisify(execFile);
  await run(process.execPath, ['-e', `fetch(${JSON.stringify(endpoint)}).then(r=>r.text()).then(console.log)`], { windowsHide: true });
  assert.equal(received, 1, 'negative control must really connect');
  const script = `const assert=require('node:assert/strict'); const {EventEmitter}=require('node:events');
    const app=new EventEmitter();app.whenReady=()=>new Promise(()=>{});
    require(${JSON.stringify(guard)}).installNetworkGuard({app,net:{},shell:{}});
    const probes=[()=>fetch(${JSON.stringify(endpoint)}),()=>require('node:http').get(${JSON.stringify(endpoint)}),()=>require('node:https').request('https://127.0.0.1'),()=>require('node:net').connect(${address.port},'127.0.0.1'),()=>require('node:tls').connect(${address.port},'127.0.0.1'),()=>require('node:http2').connect(${JSON.stringify(endpoint)}),()=>require('node:dgram').createSocket('udp4'),()=>require('node:dns').lookup('example.invalid',()=>{}),()=>new WebSocket('ws://127.0.0.1:${address.port}')];
    (async()=>{for(const probe of probes){await assert.rejects(async()=>probe(),/RELEASE_NETWORK_BLOCKED/)}console.log(JSON.stringify(globalThis.__releaseGuard.attempts))})().catch(e=>{console.error(e);process.exitCode=1});`;
  const result = await run(process.execPath, ['-e', script], { windowsHide: true });
  assert.equal(JSON.parse(result.stdout).length, 9); assert.equal(received, 1, 'guarded process must never reach local server');
});
