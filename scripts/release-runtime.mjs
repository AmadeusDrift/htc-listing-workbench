import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

async function inspectorPort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port; await new Promise(done => server.close(done)); return port;
}
async function install(port, executable, dataRoot, guardPath) {
  const deadline = Date.now() + 15000; let endpoint;
  while (!endpoint && Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) })).json();
      endpoint = targets.find(t => t.type === 'node')?.webSocketDebuggerUrl;
    } catch { /* Only poll this test launch's loopback inspector. */ }
    if (!endpoint) await delay(50);
  }
  assert.ok(endpoint?.startsWith(`ws://127.0.0.1:${port}/`), 'Missing isolated main inspector');
  const socket = new WebSocket(endpoint), pending = new Map(); let sequence = 0, pause, identity;
  const paused = new Promise(done => { pause = done; });
  socket.addEventListener('message', event => {
    const value = JSON.parse(String(event.data)); if (value.method === 'Debugger.paused') pause();
    const item = pending.get(value.id); if (!item) return;
    clearTimeout(item.timer); pending.delete(value.id); value.error ? item.reject(Error(JSON.stringify(value.error))) : item.done(value.result);
  });
  await new Promise((done, reject) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const send = (method, params = {}) => new Promise((done, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(`Inspector timed out: ${method}`)); }, 10000);
    pending.set(id, { done, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, includeCommandLineAPI: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || 'Guard injection failed');
    return result.result.value;
  };
  try {
    await send('Runtime.enable'); await send('Debugger.enable'); await send('Runtime.runIfWaitingForDebugger');
    let timer; try { await Promise.race([paused, new Promise((_done, reject) => { timer = setTimeout(() => reject(Error('Main did not pause')), 10000); })]); } finally { clearTimeout(timer); }
    identity = await evaluate('({pid:process.pid, executable:process.execPath,dataRoot:process.env.RED_DATA_DIR, ready:require("electron").app.isReady()})');
    assert.equal(resolve(identity.executable).toLowerCase(), resolve(executable).toLowerCase());
    assert.equal(identity.dataRoot, dataRoot); assert.equal(identity.ready, false, 'Guard must precede application initialization');
    assert.equal(await evaluate(`require(${JSON.stringify(guardPath)}).installNetworkGuard(); globalThis.__releaseGuard.installedBeforeMain`), true);
    await send('Debugger.resume');
  } catch (error) {
    // Never resume an unguarded application after an injection failure.
    if (identity?.pid && resolve(identity.executable).toLowerCase() === resolve(executable).toLowerCase() && identity.dataRoot === dataRoot) {
      try { process.kill(identity.pid); } catch { /* Process may already have exited. */ }
    }
    throw error;
  } finally {
    socket.close(); for (const value of pending.values()) { clearTimeout(value.timer); value.reject(Error('Inspector closed')); } pending.clear();
  }
}
export async function launchGuarded({ executable, dataRoot, guardPath, cwd, args = [] }) {
  const port = await inspectorPort();
  const env = { ...process.env, RED_DATA_DIR: dataRoot, RED_E2E: '1' };
  for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'RED_DEV_SERVER_URL', 'RED_COLLECTION_TEST_HOST']) delete env[key];
  const launching = electron.launch({ executablePath: executable, args: [`--inspect-brk=127.0.0.1:${port}`, ...args], cwd, env, timeout: 30000 });
  // Attach a rejection handler immediately while the inspector is still pending.
  const outcome = launching.then(app => ({ app }), error => ({ error }));
  try { await install(port, executable, dataRoot, guardPath); }
  catch (error) { const result = await outcome; await result.app?.close(); throw error; }
  const result = await outcome; if (result.error) throw result.error;
  assert.equal(await result.app.evaluate(() => Boolean(globalThis.__releaseGuard)), true);
  return result.app;
}

export async function probeGuard(app, endpoint = 'http://127.0.0.1:49152/guard-control') {
  return app.evaluate(async ({ net, session, BrowserWindow }, endpoint) => {
    const state = globalThis.__releaseGuard, before = state.attempts.length;
    const require = globalThis.__releaseGuard.require;
    const probes = [() => fetch('http://127.0.0.1:1'), () => require('node:http').get('http://127.0.0.1:1'),
      () => require('node:https').request('https://127.0.0.1:1'), () => require('node:net').connect(1, '127.0.0.1'),
      () => net.fetch('https://example.invalid'), () => net.request('https://example.invalid'), () => session.defaultSession.fetch('https://example.invalid')];
    for (const probe of probes) {
      let rejected = false; try { await probe(); } catch (error) { rejected = /RELEASE_NETWORK_BLOCKED/.test(String(error)); }
      if (!rejected) throw Error('Runtime network guard probe escaped');
    }
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    let blocked = false; try { await window.loadURL(endpoint); } catch { blocked = true; }
    finally { window.destroy(); }
    if (!blocked || state.attempts.at(-1) !== 'electron.session.webRequest') throw Error('Chromium network guard probe escaped');
    return { attempts: state.attempts.slice(before), total: state.attempts.length, sessions: state.sessions };
  }, endpoint);
}
