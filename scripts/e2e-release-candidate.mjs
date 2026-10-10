import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { cli, digest, reserveOutput } from './release-verification.mjs';
import { assertArtifactLocation } from './release-source.mjs';
import { verifyCandidate } from './release-package.mjs';
import { launchGuarded, probeGuard } from './release-runtime.mjs';
import { publicApi } from './api-surface.mjs';

const args = cli(['--source-repo', '--snapshot', '--package-root', '--output']);
const repo = args['--source-repo'], snapshot = args['--snapshot'], candidate = args['--package-root'], output = args['--output'];
assertArtifactLocation(repo, output);
const verified = await verifyCandidate(repo, snapshot, candidate);
await reserveOutput(output, [snapshot, candidate, join(repo, 'release')]);
const dataRoot = join(output, 'workspace'); await mkdir(dataRoot);
const executable = join(candidate, 'HTC.exe'), guardPath = join(snapshot, 'scripts/release-network-guard.cjs');
const checks = [], sessions = [], errors = []; let app;
const report = { sourceCommit: verified.manifest.source.commit, manifestSha256: verified.manifestSha256,
  exeSha256: digest(await readFile(executable)), candidate, dataRoot, activated: false, scope: 'actual candidate Electron and synthetic local data; no external provider acceptance', checks, sessions, errors };
async function launch() {
  app = await launchGuarded({ executable, dataRoot, guardPath, cwd: output });
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.red && document.querySelector('button'), null, { timeout: 20000 });
  const identity = await app.evaluate(({ app, BrowserWindow }) => ({ executable: process.execPath, appPath: app.getAppPath(), version: app.getVersion(), versions: process.versions,
    dataRoot: app.getPath('userData'), visible: BrowserWindow.getAllWindows().some(w => w.isVisible()), guard: globalThis.__releaseGuard,
    preferences: (() => { const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(); return { sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration }; })() }));
  assert.equal(resolve(identity.executable).toLowerCase(), resolve(executable).toLowerCase());
  assert.equal(resolve(identity.appPath).toLowerCase(), resolve(candidate, 'resources/app').toLowerCase());
  assert.equal(identity.dataRoot, dataRoot); assert.equal(identity.version, verified.manifest.application.version);
  assert.equal(identity.versions.electron, verified.manifest.build.runtime.version); assert.equal(identity.visible, false);
  assert.deepEqual(identity.preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  assert.deepEqual(identity.guard.attempts, []); assert.deepEqual(identity.guard.shownWindows, []);
  const bridge = await page.evaluate(() => ({ keys: Object.keys(window.red).sort(), require: typeof window.require, process: typeof window.process }));
  assert.deepEqual(bridge.keys, [...publicApi].sort()); assert.equal(bridge.require, 'undefined'); assert.equal(bridge.process, 'undefined');
  sessions.push(identity); return page;
}
try {
  let page = await launch(); checks.push('candidate execPath/appPath/version, hidden sandbox, exact public IPC API');
  const runtime = await app.evaluate(async ({ safeStorage, nativeImage }, dataRoot) => {
    const require = globalThis.__releaseGuard.require;
    if (!safeStorage.isEncryptionAvailable()) throw Error('safeStorage unavailable');
    const encrypted = safeStorage.encryptString('synthetic-release-secret');
    if (safeStorage.decryptString(encrypted) !== 'synthetic-release-secret') throw Error('safeStorage roundtrip failed');
    const { DatabaseSync } = require('node:sqlite'), db = new DatabaseSync(require('node:path').join(dataRoot, 'runtime-probe.sqlite'));
    db.exec('CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES (\'synthetic\')');
    const value = db.prepare('SELECT value FROM probe').get().value; db.close();
    const image = nativeImage.createFromBitmap(Buffer.from([10, 20, 30, 255]), { width: 1, height: 1 });
    const decoded = nativeImage.createFromBuffer(image.toPNG());
    return { sqlite: value, decoded: decoded.getSize(), encrypted: encrypted.toString('base64') };
  }, dataRoot);
  assert.equal(runtime.sqlite, 'synthetic'); assert.deepEqual(runtime.decoded, { width: 1, height: 1 });
  checks.push('actual Electron safeStorage, SQLite write, nativeImage PNG');
  assert.deepEqual(await page.evaluate(() => window.red.listProducts()), []);
  await page.getByRole('button', { name: '载入示例商品', exact: true }).click();
  await page.waitForFunction(async () => (await window.red.listProducts()).length === 2);
  const products = await page.evaluate(() => window.red.listProducts()); assert.equal(products.length, 2);
  const bag = products.find(p => p.title === '棉质抽绳收纳袋'); assert.ok(bag);
  await page.getByTestId(`product-${bag.id}`).click(); await page.getByRole('tab', { name: '图片工作区', exact: false }).click();
  await page.waitForFunction(() => { const imgs = [...document.querySelectorAll('.asset-card img')]; return imgs.length === 3 && imgs.every(img => img.complete && img.naturalWidth > 0); });
  const imageBindings = await page.evaluate(id => window.red.getProduct(id), bag.id);
  await writeFile(join(output, 'synthetic-product.json'), JSON.stringify(imageBindings, null, 2));
  const screenshot = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
  await writeFile(join(output, 'candidate-images.png'), Buffer.from(screenshot, 'base64')); checks.push('real preload/IPC sample persistence and managed image rendering');
  report.guardProbes = await probeGuard(app); assert.equal(report.guardProbes.attempts.length, 8); assert.equal(report.guardProbes.total, 8, 'Only deliberate guard probes may attempt outbound');
  await app.close(); app = undefined;
  page = await launch();
  assert.deepEqual((await page.evaluate(() => window.red.listProducts())).map(p => p.id).sort(), products.map(p => p.id).sort());
  const restored = await app.evaluate(async ({ safeStorage }, { dataRoot, encrypted }) => {
    const require = globalThis.__releaseGuard.require;
    const db = new (require('node:sqlite').DatabaseSync)(require('node:path').join(dataRoot, 'runtime-probe.sqlite'));
    const value = db.prepare('SELECT value FROM probe').get().value; db.close();
    return { value, secret: safeStorage.decryptString(Buffer.from(encrypted, 'base64')), attempts: globalThis.__releaseGuard.attempts, shown: globalThis.__releaseGuard.shownWindows };
  }, { dataRoot, encrypted: runtime.encrypted });
  assert.equal(restored.value, 'synthetic'); assert.equal(restored.secret, 'synthetic-release-secret'); assert.deepEqual(restored.attempts, []); assert.deepEqual(restored.shown, []);
  checks.push('same candidate restart preserves SQLite, encrypted synthetic secret and product IDs; no outbound');
  assert.deepEqual(errors, []); report.passed = true;
} catch (error) { report.passed = false; report.failure = String(error.stack || error); throw error; }
finally {
  await app?.close();
  const after = await verifyCandidate(repo, snapshot, candidate); assert.equal(after.manifestSha256, verified.manifestSha256);
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
