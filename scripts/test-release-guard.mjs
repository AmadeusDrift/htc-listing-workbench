import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { launchGuarded, probeGuard } from './release-runtime.mjs';

// Guard mechanism test with a tiny synthetic app, not candidate acceptance.
await mkdir(resolve('.test-data'), { recursive: true });
const root = await mkdtemp(resolve('.test-data/release-guard-electron-'));
const require = createRequire(import.meta.url), executable = require('electron');
let received = 0, app;
const server = createServer((_request, response) => { received++; response.end('<title>Loopback control</title>'); });
await new Promise(done => server.listen(0, '127.0.0.1', done));
const endpoint = `http://127.0.0.1:${server.address().port}/guard-control`;
const main = join(root, 'main.cjs');
await writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',process.env.RED_DATA_DIR);globalThis.guardAtEntry=Boolean(globalThis.__releaseGuard);app.whenReady().then(()=>{const w=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});return w.loadURL(process.env.HTC_GUARD_CONTROL||'data:text/html,<title>Guarded fixture</title>')});`);
try {
  const env = { ...process.env, RED_DATA_DIR: join(root, 'control'), RED_E2E: '1', HTC_GUARD_CONTROL: endpoint }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  app = await electron.launch({ executablePath: executable, args: [main], env });
  await (await app.firstWindow()).waitForFunction(() => document.title === 'Loopback control');
  assert.ok(received > 0); await app.close(); app = undefined;
  const before = received;
  app = await launchGuarded({ executable, dataRoot: join(root, 'guarded'), guardPath: resolve('scripts/release-network-guard.cjs'), cwd: root, args: [main] });
  assert.equal(await app.evaluate(() => globalThis.guardAtEntry), true);
  const probes = await probeGuard(app, endpoint); assert.equal(received, before, 'Guarded Chromium must not reach loopback control');
  assert.equal(probes.attempts.length, 8); assert.equal(probes.sessions > 0, true);
  console.log(JSON.stringify({ syntheticGuardOnly: true, guardedBeforeEntry: true, negativeControlReceived: before, guardedReceived: received - before, probes }, null, 2));
} finally { await app?.close(); await new Promise(done => server.close(done)); }
