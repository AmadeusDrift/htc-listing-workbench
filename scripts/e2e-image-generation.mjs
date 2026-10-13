import { _electron as electron } from 'playwright';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { publicApi } from './api-surface.mjs';

// Exercise the production UI, preload, IPC, safeStorage and image service. Only
// main-process transports are replaced; no renderer window.red methods are mocked.
// The fake key, generated PNG and fresh data directory never use live services.
const root = resolve('.'), artifacts = resolve('artifacts');
await mkdir(resolve('.test-data'), { recursive: true });
await mkdir(artifacts, { recursive: true });
const dataRoot = await mkdtemp(resolve('.test-data/image-generation-e2e-'));
const require = createRequire(import.meta.url);
const executablePath = process.env.RED_E2E_EXECUTABLE || require('electron');
const buildRoot = process.env.RED_E2E_EXECUTABLE ? join(dirname(resolve(executablePath)), 'resources', 'app') : root;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const build = {
  packaged: Boolean(process.env.RED_E2E_EXECUTABLE),
  version: JSON.parse(await readFile(join(buildRoot, 'package.json'), 'utf8')).version,
  mainSha256: sha256(await readFile(join(buildRoot, 'dist-electron/main.cjs'))),
  preloadSha256: sha256(await readFile(join(buildRoot, 'dist-electron/preload.cjs'))),
  rendererAssets: [...(await readFile(join(buildRoot, 'dist/index.html'), 'utf8')).matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]),
};
const artifactPrefix = build.packaged ? 'image-generation-packaged' : 'image-generation';
const env = { ...process.env, RED_DATA_DIR: dataRoot, RED_E2E: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.RED_DEV_SERVER_URL; delete env.RED_COLLECTION_TEST_HOST;
process.env.electron_config_cache = resolve('.cache/electron');
const fakeKey = 'sk-htc-e2e-fake-not-a-real-openai-key';
const fakeRelayKey = 'tyai-htc-e2e-fake-not-a-real-relay-key';
const privateMarker = 'E2E_PRIVATE_UPSTREAM_DETAIL';
const sunburst = 'openai/gpt-image-2.5-sunburst', flare = 'openai/gpt-image-2.5-flare';
const relayModel = 'gpt-image-2.5-sunburst-4k-max';
const checks = [], screenshots = [], layouts = [], candidates = [], errors = [], processLog = [], sessions = [];
const startedAt = new Date().toISOString();
let app, page, succeeded = false, failure = null;
const pass = message => { checks.push(message); console.log(`PASS ${message}`); };
const form = () => page.getByRole('form', { name: 'OpenRouter 生图连接配置', exact: true });
const relayForm = () => page.getByRole('form', { name: 'Tyai 生图连接配置', exact: true });
const providerInput = () => page.getByRole('combobox', { name: '生图服务', exact: true });
const keyInput = () => form().getByLabel('OpenRouter API Key', { exact: true });
const modelInput = () => form().getByRole('combobox', { name: '生图模型', exact: true });
const enableInput = () => form().getByRole('checkbox', { name: '启用生图接口', exact: true });
const button = name => page.getByRole('button', { name, exact: true });
const badge = () => form().locator('.credential-heading [role=status]');
const connection = () => page.evaluate(() => window.red.getImageGenerationConnection());
const calls = () => app.evaluate(() => globalThis.__imageGenerationE2E.calls);
const mode = value => app.evaluate((_electron, value) => { globalThis.__imageGenerationE2E.mode = value; }, value);
const candidateDirectories = () => readdir(join(dataRoot, 'image-generation', 'candidates')).then(names => names.sort()).catch(error => {
  if (error.code === 'ENOENT') return [];
  throw error;
});

async function launch() {
  app = await electron.launch({ executablePath, args: process.env.RED_E2E_EXECUTABLE ? [] : ['.'], cwd: root, env, timeout: 35000 });
  app.process().stderr.on('data', chunk => processLog.push(chunk.toString()));
  // Install before interacting with the first renderer. All unknown requests fail
  // closed, and Chromium HTTP(S) requests are separately cancelled at the session.
  await app.evaluate(({ app, BrowserWindow, nativeImage, net, session }, { fakeKey, fakeRelayKey, privateMarker }) => {
    const size = 1024, bitmap = Buffer.alloc(size * size * 4);
    for (let offset = 0; offset < bitmap.length; offset += 4) {
      bitmap[offset] = 211; bitmap[offset + 1] = 167; bitmap[offset + 2] = 73; bitmap[offset + 3] = 255;
    }
    const png = nativeImage.createFromBitmap(bitmap, { width: size, height: size }).toPNG().toString('base64');
    const state = globalThis.__imageGenerationE2E = { mode: 'ok', calls: [], pending: [], unexpected: [], remoteRequests: [], shownWindows: [], png };
    const observe = window => {
      window.webContents.setBackgroundThrottling(false);
      if (window.isVisible()) state.shownWindows.push(window.id);
      window.on('show', () => state.shownWindows.push(window.id));
    };
    for (const window of BrowserWindow.getAllWindows()) observe(window);
    app.on('browser-window-created', (_event, window) => observe(window));
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      state.remoteRequests.push(details.url); callback({ cancel: true });
    });
    globalThis.fetch = async url => {
      state.unexpected.push({ transport: 'global-fetch', url: String(url) });
      throw new Error('Unexpected network request in isolated image-generation test');
    };
    net.fetch = async (url, options = {}) => {
      const address = String(url), method = options.method || 'GET';
      const provider = 'openrouter';
      if (!(method === 'GET' && /^https:\/\/openrouter\.ai\/api\/v1\/images\/models\/openai\/gpt-image-2\.5-(?:sunburst|flare)\/endpoints$/.test(address))
        && !(method === 'GET' && address === 'https://openrouter.ai/api/v1/images/models')
        && !(method === 'POST' && address === 'https://openrouter.ai/api/v1/images')) {
        state.unexpected.push({ transport: 'electron-net', url: address, method });
        throw new Error('Unexpected network request in isolated image-generation test');
      }
      const headers = new Headers(options.headers);
      const multipart = options.body instanceof FormData;
      let body = options.body === undefined ? null : multipart ? {} : JSON.parse(options.body);
      if (multipart) for (const [key, value] of options.body.entries()) {
        if (typeof value === 'string') body[key] = value;
        else (body[key] ??= []).push({ name: value.name, mimeType: value.type, byteSize: value.size, base64: Buffer.from(await value.arrayBuffer()).toString('base64') });
      }
      const call = { url: address, provider, method, body, bodyType: multipart ? 'multipart' : body ? 'json' : null,
        authorizationMatches: headers.get('authorization') === `Bearer ${fakeKey}`, accept: headers.get('accept'),
        contentType: headers.get('content-type'), redirect: options.redirect, bypassCustomProtocolHandlers: options.bypassCustomProtocolHandlers,
        mode: state.mode, aborted: false };
      state.calls.push(call);
      options.signal?.addEventListener('abort', () => { call.aborted = true; }, { once: true });
      const respond = () => new Response(JSON.stringify(address === 'https://openrouter.ai/api/v1/images/models'
        ? {data:['openai/gpt-image-2.5-sunburst','openai/gpt-image-2.5-flare','future-image-v3'].map(id=>({id}))}
        : method === 'GET'
        ? { data: { endpoints: [{ name: 'OpenAI', provider_name: 'OpenAI' }] } }
        : { id: `req-image-e2e-${state.calls.length}`, data: [{ b64_json: png, media_type: 'image/png' }] }),
      { headers: { 'content-type': 'application/json', 'x-request-id': `req-image-e2e-${state.calls.length}` } });
      // Ignore abort at the mock transport so the service must discard a late
      // provider response itself, even after its caller has already cancelled.
      if (state.mode === 'hold') return new Promise(resolve => state.pending.push(() => resolve(state.mode === 'hold-failure' ? new Response(JSON.stringify({error:{message:privateMarker}}),{status:403}) : respond())));
      if (state.mode === 'network-error') throw new Error(`${privateMarker} ${fakeKey}`);
      const status = { unauthorized: 401, forbidden: 403, 'rate-limited': 429 }[state.mode];
      if (status) return new Response(JSON.stringify({ error: { message: `${privateMarker} ${fakeKey}`, type: 'provider_detail', code: 'provider_detail', param: null } }), { status });
      return respond();
    };
  }, { fakeKey, fakeRelayKey, privateMarker });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await expect(button('新建商品')).toBeEnabled();
  await assertHidden();
  const paths = await app.evaluate(({ app }) => ({ data: app.getPath('userData'), browser: app.getPath('sessionData') }));
  assert.deepEqual(paths, { data: dataRoot, browser: join(dataRoot, 'browser') });
  assert.equal((await page.evaluate(() => window.red.getSettings())).dataDirectory, dataRoot);
}

async function assertHidden() {
  const state = await app.evaluate(({ BrowserWindow }) => ({ visible: BrowserWindow.getAllWindows().some(window => window.isVisible()), shown: globalThis.__imageGenerationE2E.shownWindows }));
  assert.equal(state.visible, false, 'The isolated Electron window must remain hidden');
  assert.deepEqual(state.shown, [], 'The isolated Electron window must never be shown');
}

async function close() {
  if (!app) return;
  await assertHidden();
  sessions.push(await app.evaluate(() => {
    const { calls, unexpected, remoteRequests, shownWindows } = globalThis.__imageGenerationE2E;
    return { calls: calls.map(({ body, ...call }) => ({ ...call, body: body && {
      model: body.model, n: body.n, size: body.size, quality: body.quality, background: body.background, output_format: body.output_format,
      fields: Object.keys(body).sort(), referenceImages: body.input_references?.length || 0,
    } })), unexpected, remoteRequests, shownWindows };
  }));
  await app.close(); app = null; page = null;
}

async function click(target) {
  await expect(target).toBeVisible(); await expect(target).toBeEnabled();
  // Hidden native windows may stop animation stability frames; preserve real
  // event handlers but skip Playwright's animation wait after these assertions.
  await target.click({ force: true });
}

async function module(id) {
  const target = page.locator(`#settings-nav-${id}`);
  if (await target.isVisible()) await click(target);
  else await page.locator('.settings-module-select select').selectOption(id);
  await expect(target).toHaveAttribute('aria-current', 'page');
  if (id === 'images') await expect(page.locator('.image-generation-settings')).toHaveAttribute('aria-busy', 'false');
}

async function settings() {
  const target = page.locator('.primary-navigation').getByRole('button', { name: '设置', exact: true });
  await click(target); await expect(target).toHaveAttribute('aria-current', 'page');
  await module('images');
}

async function settle() {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.race([new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))), new Promise(done => setTimeout(done, 150))]);
  });
}

async function screenshot(name) {
  // Windows can retain the initial compositor surface for a never-shown window;
  // invalidate() alone does not refresh it. A hidden resize/restore requests a
  // new surface, with both native and renderer dimensions settled at each step.
  const [width, height] = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize());
  await resize(width + 1, height); await resize(width, height);
  await settle(); await assertHidden();
  const base64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
  const path = join(artifacts, `${artifactPrefix}-${name}.png`);
  await writeFile(path, Buffer.from(base64, 'base64')); screenshots.push(path);
  await assertHidden(); console.log(`SCREENSHOT ${path}`);
}

async function resize(width, height) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
  await expect.poll(async () => {
    const native = await app.evaluate(({ BrowserWindow }) => ({ outer: BrowserWindow.getAllWindows()[0].getSize(), content: BrowserWindow.getAllWindows()[0].getContentSize() }));
    const viewport = await page.evaluate(() => [innerWidth, innerHeight]);
    return native.outer[0] === width && native.outer[1] === height && native.content.every((value, index) => value === viewport[index]);
  }).toBe(true);
  await settle();
}

async function layoutAndContrast(name) {
  const result = await page.evaluate(() => {
    const selectors = ['.main-content', '.settings-panel', '.settings-layout', '.settings-module-content', '.image-generation-settings', '.image-generation-form', '.image-generation-fields', '.credential-actions'];
    const overflow = selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length && element.clientWidth && element.scrollWidth > element.clientWidth + 2).map(element => ({ selector, width: element.clientWidth, scroll: element.scrollWidth })));
    if (document.documentElement.scrollWidth > innerWidth + 2) overflow.push({ selector: 'document', width: innerWidth, scroll: document.documentElement.scrollWidth });
    const rgba = value => { const values = value.match(/[\d.]+/g).map(Number); return [values[0], values[1], values[2], values[3] ?? 1]; };
    const blend = (top, bottom) => { const alpha = top[3] + bottom[3] * (1 - top[3]); return [...top.slice(0, 3).map((value, i) => alpha ? (value * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / alpha : 0), alpha]; };
    const background = element => {
      let color = [0, 0, 0, 0];
      for (let node = element; node && color[3] < .999; node = node.parentElement) color = blend(color, rgba(getComputedStyle(node).backgroundColor));
      return blend(color, [255, 255, 255, 1]);
    };
    const luminance = color => color.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
    const samples = [...document.querySelectorAll('.image-generation-form .credential-heading h4, .image-generation-form .credential-heading [role=status], .image-generation-endpoint code, .image-generation-form .field > span, .image-generation-form .field > small, .image-generation-form .settings-help, .image-generation-field-help, .image-generation-enable label > span, .image-generation-check-help, .image-generation-form .button:not(:disabled), .image-generation-form .workflow-warning, .image-generation-form .workflow-notice')]
      .filter(element => element.getClientRects().length && element.textContent.trim())
      .map(element => {
        const bg = background(element), fg = blend(rgba(getComputedStyle(element).color), bg), a = luminance(fg), b = luminance(bg);
        return { text: element.textContent.trim().slice(0, 90), fg, bg, contrast: Number(((Math.max(a, b) + .05) / (Math.min(a, b) + .05)).toFixed(2)) };
      });
    return { width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme, overflow, samples };
  });
  layouts.push({ name, ...result });
  assert.deepEqual(result.overflow, [], `Unexpected horizontal overflow: ${name}`);
  assert.ok(result.samples.length >= 10);
  assert.deepEqual(result.samples.filter(sample => sample.contrast < 4.5), [], `Text contrast below 4.5:1: ${name}`);
}

async function rejected(input, expected) {
  const result = await page.evaluate(async input => {
    try { await window.red.generateImageCandidate(input); return { ok: true }; }
    catch (error) { return { ok: false, message: error.message }; }
  }, input);
  assert.equal(result.ok, false); assert.equal(result.message, expected); assertPrivate(result);
}

function assertPrivate(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(text.includes(fakeKey), false, 'The API key must never be returned or logged');
  assert.equal(text.includes(fakeRelayKey), false, 'The relay API key must never be returned or logged');
  assert.equal(text.includes(privateMarker), false, 'Raw upstream diagnostics must never reach the renderer or logs');
}

async function assetHashes() {
  const directory = join(dataRoot, 'assets'), names = (await readdir(directory)).sort();
  return Object.fromEntries(await Promise.all(names.map(async name => [name, sha256(await readFile(join(directory, name)))])));
}

async function verifyCandidate(candidate, expectedMode, product, sources, expected = { provider: 'openrouter', model: flare }) {
  assert.equal(candidate.mode, expectedMode); assert.equal(candidate.provider, expected.provider); assert.equal(candidate.model, expected.model);
  assert.equal(candidate.reviewState, 'unreviewed'); assert.equal(candidate.productId, product.id); assert.equal(candidate.productRevision, product.revision);
  assert.equal(candidate.mimeType, 'image/png'); assert.equal(candidate.width, 1024); assert.equal(candidate.height, 1024);
  assert.deepEqual(candidate.sourceAssets, sources); assert.match(candidate.requestId, /^req-image-e2e-\d+$/);
  assert.match(candidate.previewUrl, /^data:image\/png;base64,/); assertPrivate(candidate);
  const directory = join(dataRoot, 'image-generation', 'candidates', candidate.id);
  assert.deepEqual((await readdir(directory)).sort(), ['candidate.json', 'image.png', 'preview.png']);
  const [bytes, preview, metadata] = await Promise.all([readFile(join(directory, 'image.png')), readFile(join(directory, 'preview.png')), readFile(join(directory, 'candidate.json'), 'utf8')]);
  assert.equal(bytes.toString('base64'), expected.bytes ?? await app.evaluate(() => globalThis.__imageGenerationE2E.png));
  assert.equal(sha256(bytes), candidate.sha256); assert.equal(bytes.length, candidate.byteSize);
  assert.equal(preview.toString('base64'), candidate.previewUrl.split(',')[1]);
  assert.deepEqual(await app.evaluate(({ nativeImage }, base64) => {
    const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
    return { empty: image.isEmpty(), size: image.getSize() };
  }, preview.toString('base64')), { empty: false, size: { width: 640, height: 640 } });
  const { previewUrl: _previewUrl, ...record } = candidate;
  assert.deepEqual(JSON.parse(metadata), { ...record, previewSha256: sha256(preview) }); assertPrivate(metadata);
  candidates.push({ ...record, files: ['candidate.json', 'image.png', 'preview.png'] });
}

try {
  await launch();
  assert.deepEqual((await page.evaluate(() => Object.keys(window.red))).sort(), [...publicApi].sort());
  await settings();
  const absent = { provider: 'openrouter', activeProvider: 'openrouter', model: sunburst, size: 'auto', quality: 'auto', configured: false, enabled: false, credentialState: 'absent', accessCheck: 'not-checked', checkedAt: null };
  assert.deepEqual(await connection(), absent);
  await expect(badge()).toHaveText('未配置'); await expect(modelInput()).toHaveValue(sunburst);
  await expect(keyInput()).toHaveValue(''); await expect(keyInput()).toHaveAttribute('type', 'password'); await expect(keyInput()).toHaveAttribute('autocomplete', 'new-password');
  await expect(enableInput()).not.toBeChecked(); await expect(enableInput()).toBeEnabled();
  await expect(button('检查模型访问')).toBeDisabled(); await expect(button('保存配置')).toBeDisabled();
  await expect(button('断开 OpenRouter')).toBeDisabled(); assert.deepEqual(await calls(), []);
  assert.equal(await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable()), true);
  pass('fresh isolated workspace starts unconfigured and disabled; password is masked and startup/settings make no requests');

  const product = await page.evaluate(async () => {
    await window.red.loadWorkspaceExamples('inbox'); await window.red.loadExamples();
    const placements = await window.red.listWorkspacePlacements(), rows = await window.red.listProducts();
    const manualIds = new Set(placements.filter(item => item.lane === 'manual').map(item => item.productId));
    return window.red.getProduct(rows.find(item => manualIds.has(item.id) && item.title === '棉质抽绳收纳袋').id);
  });
  assert.ok(product.assets.length >= 2); assert.equal((await page.evaluate(() => window.red.listProducts())).length, 4);
  const initialAssets = await assetHashes(), initialDrafts = await page.evaluate(id => window.red.listAmazonDrafts(id), product.id);
  const input = { productId: product.id, productRevision: product.revision, prompt: 'E2E product study on a plain background.', referenceAssetIds: [], size: '1024x1024', quality: 'high', background: 'opaque' };
  await rejected(input, 'AI 凭据不可用，请在设置中重新填写或导入配置');
  await keyInput().fill(fakeKey); await click(page.locator('#settings-nav-ai')); await click(button('放弃修改')); await module('images');
  await expect(keyInput()).toHaveValue(''); assert.deepEqual(await calls(), []);
  pass('production example IPC creates real managed source PNGs; leaving the settings module clears an unsaved key');

  await keyInput().fill(fakeKey); await click(button('保存配置'));
  await expect(badge()).toHaveText('已保存 · 未启用'); await expect(keyInput()).toHaveValue('');
  await expect(enableInput()).toBeEnabled(); await expect(enableInput()).not.toBeChecked();
  await expect(form().locator('.workflow-notice')).toContainText('没有生成图片');
  const sharedCiphertext = await readFile(join(dataRoot,'ai-vault','openrouter.bin'));
  assert.equal(sharedCiphertext.includes(Buffer.from(fakeKey)),false);
  assert.equal(await app.evaluate(({safeStorage},{encoded,key}) => JSON.parse(safeStorage.decryptString(Buffer.from(encoded,'base64'))).credentials.apiKey === key,{encoded:sharedCiphertext.toString('base64'),key:fakeKey}),true);
  const saved = await connection(); assert.equal(saved.configured, true); assert.equal(saved.enabled, false); assertPrivate(saved);
  const vaultFile = join(dataRoot, 'ai-vault', 'openrouter-images.bin'), ciphertext = await readFile(vaultFile);
  assert.equal(ciphertext.includes(Buffer.from(fakeKey)), false);
  assert.deepEqual(await app.evaluate(({ safeStorage }, { encoded, expected }) => {
    const config = JSON.parse(safeStorage.decryptString(Buffer.from(encoded, 'base64')));
    return { version: config.version, provider: config.provider, model: config.model, enabled: config.enabled, size: config.size, quality: config.quality, keyMatches: config.apiKey === '', credentialRef: config.credentialRef };
  }, { encoded: ciphertext.toString('base64'), expected: fakeKey }), { version: 1, provider: 'openrouter', model: sunburst, enabled: false, size: 'auto', quality: 'auto', keyMatches: true, credentialRef: 'openrouter' });
  await rejected(input, 'AI 接口尚未启用'); assert.deepEqual(await calls(), []);
  pass('UI saves a real safeStorage-encrypted credential, returns metadata only and keeps generation disabled without network');

  await click(button('检查模型访问')); assert.equal((await connection()).accessCheck, 'accessible');
  await expect(form().locator('.workflow-notice')).toContainText('真实生图权限、费用和质量仍待验证');
  assert.equal((await connection()).enabled, false);
  assert.deepEqual((await calls()).map(call => ({ url: call.url, method: call.method, body: call.body })), [{ url: `https://openrouter.ai/api/v1/images/models/${sunburst}/endpoints`, method: 'GET', body: null }]);
  await modelInput().selectOption(flare);
  await form().getByRole('combobox',{name:'默认尺寸',exact:true}).selectOption('1536x1024');
  await form().getByRole('combobox',{name:'默认质量',exact:true}).selectOption('high'); await expect(button('检查模型访问')).toBeDisabled(); await expect(button('刷新状态')).toBeDisabled();
  await expect(form().locator('.image-generation-unsaved')).toContainText('有未保存的更改');
  assert.equal((await connection()).model, sunburst); assert.equal((await calls()).length, 1);
  await click(button('保存配置')); await expect(badge()).toHaveText('已保存 · 未启用');
  assert.equal((await connection()).model, flare); assert.equal((await connection()).accessCheck, 'not-checked');
  await enableInput().check({ force: true }); await expect(button('检查模型访问')).toBeDisabled();
  assert.equal((await connection()).enabled, false);
  await click(button('保存配置')); await expect(badge()).toHaveText('已启用'); await expect(keyInput()).toHaveValue('');
  assert.equal((await connection()).size,'1536x1024'); assert.equal((await connection()).quality,'high');
  assert.deepEqual(await readFile(join(dataRoot,'ai-vault','openrouter.bin')),sharedCiphertext);
  assert.equal((await calls()).length, 1);
  pass('explicit model check sends one GET; dirty model/enable edits block checks and blank-key saves preserve the credential');

  for (const [responseMode, message] of [
    ['unauthorized', '当前凭据没有此功能的服务权限，请检查对应服务是否开通及账号授权；无需因此重新填写已保存的密钥'],
    ['forbidden', '当前凭据没有此功能的服务权限，请检查对应服务是否开通及账号授权；无需因此重新填写已保存的密钥'],
  ]) {
    await mode(responseMode); const before = (await calls()).length;
    await click(button('检查模型访问')); await expect(form().getByRole('alert')).toHaveText(message);
    assert.equal((await connection()).accessCheck, 'failed');
    const state = await connection(); assert.equal(state.configured, true); assert.equal(state.enabled, true); assert.equal(state.accessCheck, 'failed');
    assert.equal((await calls()).length, before + 1); assertPrivate(await page.locator('body').innerText());
  }
  await screenshot('access-error');
  await mode('ok');
  const persisted = await connection(), savedCiphertext = await readFile(vaultFile);
  await close(); await launch(); await settings();
  assert.deepEqual(await connection(), { ...persisted, accessCheck: 'not-checked', checkedAt: null });
  assert.deepEqual(await readFile(vaultFile), savedCiphertext);
  await expect(keyInput()).toHaveValue(''); await expect(enableInput()).toBeChecked(); await expect(modelInput()).toHaveValue(flare);
  await expect(badge()).toHaveText('已启用'); assert.deepEqual(await calls(), []);
  assert.deepEqual(await page.evaluate(id => window.red.getProduct(id), product.id), product);
  const capability = (await page.evaluate(() => window.red.listAiCapabilities())).find(item => item.capability === 'image-generation');
  assert.equal(capability.providerId, 'openrouter-images'); assert.equal(capability.available, true);
  pass('real hidden Electron restart preserves encrypted key/model/enable and product; access-check evidence is correctly reset');

  for (const [value, message] of [
    [{ ...input, productRevision: product.revision + 1 }, '商品或来源图片已变化，请重新加载后再试'],
    [{ ...input, referenceAssetIds: [product.assets[0].id, product.assets[0].id] }, 'AI 请求参数无效'],
    [{ ...input, size: '4096x4096' }, 'AI 请求参数无效'],
    [{ ...input, quality: 'max' }, 'AI 请求参数无效'],
    [{ ...input, quality: 'xhigh' }, 'AI 请求参数无效'],
    [{ ...input, imagePath: 'C:/not-an-accepted-source.png' }, 'AI 配置或记录格式无效，请检查所填字段或配置文件'],
  ]) await rejected(value, message);
  const foreign = await page.evaluate(async id => window.red.getProduct((await window.red.listProducts()).find(row => row.id !== id).id), product.id);
  await rejected({ ...input, referenceAssetIds: [foreign.assets[0].id] }, '商品或来源图片已变化，请重新加载后再试');
  assert.deepEqual(await calls(), []);
  pass('real IPC rejects stale product revisions, duplicate/foreign source IDs and renderer-supplied file paths before any transport');

  const generated = await page.evaluate(input => window.red.generateImageCandidate(input), input);
  await verifyCandidate(generated, 'generate', product, []);
  const editInput = { ...input, prompt: 'E2E replace fixture background only.', referenceAssetIds: product.assets.slice(0, 2).map(asset => asset.id), size: 'auto', quality: 'high', background: 'transparent' };
  const sources = await Promise.all(editInput.referenceAssetIds.map(async id => ({ id, sha256: sha256(await readFile(join(dataRoot, 'assets', `${id}.png`))) })));
  const edited = await page.evaluate(input => window.red.generateImageCandidate(input), editInput);
  await verifyCandidate(edited, 'edit', product, sources);
  const requests = await calls(); assert.equal(requests.length, 2);
  for (const [index, request] of requests.entries()) {
    const source = index ? editInput : input;
    assert.equal(request.url, 'https://openrouter.ai/api/v1/images');
    assert.equal(request.method, 'POST'); assert.equal(request.authorizationMatches, true); assert.equal(request.accept, 'application/json');
    assert.equal(request.contentType, 'application/json'); assert.equal(request.redirect, 'error'); assert.equal(request.bypassCustomProtocolHandlers, true);
    const expected = { model: flare, prompt: source.prompt, n: 1, output_format: 'png', size: source.size, quality: source.quality, background: source.background, provider: { only: ['openai'], allow_fallbacks: false } };
    if (index) expected.input_references = await Promise.all(source.referenceAssetIds.map(async id => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${(await readFile(join(dataRoot, 'assets', `${id}.png`))).toString('base64')}` } })));
    assert.deepEqual(request.body, expected, 'Only supported OpenRouter Images API fields may be sent');
  }
  assert.deepEqual(await candidateDirectories(), [generated.id, edited.id].sort());
  pass('generation/edit IPC send exact OpenRouter JSON with main-read reference data URLs and persist decoded unreviewed PNG candidates');

  for (const [responseMode, message] of [['network-error', 'AI 网络请求未完成，请先核对调用记录'], ['rate-limited', 'AI 接口请求频率受限，请稍后重试']]) {
    await mode(responseMode); const before = (await calls()).length;
    await rejected(input, message); assert.equal((await calls()).length, before + 1);
    assert.deepEqual(await candidateDirectories(), [generated.id, edited.id].sort());
  }
  await mode('hold'); const beforeCancel = (await calls()).length;
  const pending = page.evaluate(async input => {
    try { await window.red.generateImageCandidate(input); return { ok: true }; }
    catch (error) { return { ok: false, message: error.message }; }
  }, input);
  await expect.poll(async () => (await calls()).length).toBe(beforeCancel + 1);
  await rejected(input, 'AI 请求数量已达上限，请等待当前请求完成');
  await page.evaluate(() => window.red.cancelImageGeneration());
  assert.deepEqual(await pending, { ok: false, message: 'AI 请求已取消' });
  assert.equal((await calls()).at(-1).aborted, true);
  await app.evaluate(async () => {
    for (const release of globalThis.__imageGenerationE2E.pending.splice(0)) release();
    await new Promise(done => setImmediate(done));
  });
  assert.equal((await calls()).length, beforeCancel + 1);
  assert.deepEqual(await candidateDirectories(), [generated.id, edited.id].sort());
  assert.deepEqual(await page.evaluate(id => window.red.getProduct(id), product.id), product);
  assert.deepEqual(await page.evaluate(id => window.red.listAmazonDrafts(id), product.id), initialDrafts);
  assert.deepEqual(await page.evaluate(id => window.red.listImageVersions(id), product.id), []);
  assert.deepEqual(await page.evaluate(id => window.red.listImageSelections(id), product.id), []);
  assert.deepEqual(await assetHashes(), initialAssets);
  pass('failed/cancelled paid POSTs are not retried; busy request is rejected and late response cannot save or adopt a candidate');
  pass('original asset bytes, product revision, listing drafts and image selections remain unchanged');

  await mode('hold'); const beforeCheck = (await calls()).length;
  await click(button('检查模型访问')); await expect(button('检查模型访问')).toBeDisabled();
  await module('ai');
  // Reopen while the request is still pending; do not use module(), which waits
  // for aria-busy=false and would conceal a premature unlock regression.
  await click(page.locator('#settings-nav-images'));
  await expect(keyInput()).toBeDisabled(); await expect(button('检查模型访问')).toBeDisabled();
  await app.evaluate(() => { for (const release of globalThis.__imageGenerationE2E.pending.splice(0)) release(); });
  assert.equal((await connection()).accessCheck, 'accessible'); await expect(button('检查模型访问')).toBeEnabled();
  assert.equal((await calls()).length, beforeCheck + 1);
  assert.ok((await calls()).slice(beforeCheck).every(call => call.method === 'GET' && call.body === null && call.authorizationMatches));
  pass('401/403 checks expose fixed safe errors; pending checks stay locked across hide/reopen and never send a generation POST');
  await mode('hold'); await click(button('检查模型访问')); await expect(keyInput()).toBeDisabled();
  await module('ai'); await click(page.locator('#settings-nav-images')); await expect(keyInput()).toBeDisabled();
  await mode('hold-failure');
  await app.evaluate(() => { for (const release of globalThis.__imageGenerationE2E.pending.splice(0)) release(); });
  await expect(form().getByRole('alert')).toContainText('当前凭据没有此功能的服务权限');
  await expect(keyInput()).toBeEnabled(); assert.equal((await connection()).accessCheck,'failed');
  const beforeBadSave = await connection(), beforeBadSaveCalls = (await calls()).length;
  await keyInput().fill('invalid key with spaces'); await click(button('保存配置'));
  await expect(form().getByRole('alert')).toBeVisible(); await expect(keyInput()).toBeEnabled();
  assert.deepEqual(await connection(),beforeBadSave); assert.equal((await calls()).length,beforeBadSaveCalls);
  await click(page.locator('#settings-nav-ai')); await click(button('放弃修改')); await module('images');
  assert.deepEqual(await connection(),beforeBadSave); await expect(keyInput()).toHaveValue('');
  await form().getByRole('combobox',{name:'默认尺寸',exact:true}).selectOption('1024x1536');
  await click(button('保存配置')); await expect(form().locator('.workflow-notice')).toContainText('生图配置已保存'); await expect(page.locator('.image-generation-settings')).toHaveAttribute('aria-busy','false'); await expect(button('保存配置')).toBeDisabled();
  await module('ai'); await module('images');
  await expect(form().getByRole('combobox',{name:'默认尺寸',exact:true})).toHaveValue('1024x1536');
  assert.deepEqual(await readFile(join(dataRoot,'ai-vault','openrouter.bin')),sharedCiphertext);
  pass('pending failed check restores editable state; failed save cannot mutate credentials and successful defaults survive page navigation');


  await mode('ok');
  await mode('ok');
  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await click(button(theme === 'dark' ? '切换到夜间模式' : '切换到日间模式'));
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const [width, height] of [[1480, 960], [1080, 850], [760, 680]]) {
      await resize(width, height); await form().evaluate(element => element.scrollIntoView({ block: 'start' }));
      await screenshot(`${theme}-${width}`); await layoutAndContrast(`${theme}/${width}`);
      if (width === 760) {
        await form().locator('.credential-actions').evaluate(element => element.scrollIntoView({ block: 'center' }));
        await screenshot(`${theme}-${width}-controls`);
      }
    }
  }
  pass('image settings fit 1480/1080/760 widths in both themes; visible key/model/status/help/action text meets 4.5:1 contrast');

  // API-R2 retires writable official/Tyai/Gemini/custom relay profiles. Their
  // old activation/POST scenarios are replaced by explicit rejection and history
  // assertions, never by silently accepting the old endpoints in the fake.
  await expect(providerInput()).toHaveCount(0);
  await expect(relayForm()).toHaveCount(0);
  const beforeCatalog = await connection(), beforeCatalogCalls = (await calls()).length;
  const catalog = await page.evaluate(() => window.red.refreshImageGenerationModels());
  assert.equal(catalog.source,'remote'); assert.deepEqual(catalog.models.map(item=>item.id),[sunburst,flare]);
  assert.deepEqual(await connection(),beforeCatalog); assertPrivate(catalog);
  assert.equal((await calls()).length,beforeCatalogCalls+1);
  assert.equal((await calls()).at(-1).method,'GET');
  assert.equal((await calls()).at(-1).url,'https://openrouter.ai/api/v1/images/models');
  pass('explicit catalog IPC accepts only the two active image slugs and preserves connection without a generation POST');
  const beforeLegacy = (await calls()).length;
  for (const provider of ['openai', 'tyai']) {
    const result = await page.evaluate(async ({provider, model, apiKey}) => {
      const outcomes = [];
      for (const work of [() => window.red.getImageGenerationConnection(provider),
        () => window.red.saveImageGenerationConnection({provider, model, apiKey, enabled:true}),
        () => window.red.checkImageGenerationConnection(provider),
        () => window.red.disconnectImageGenerationConnection(provider)]) {
        try { await work(); outcomes.push('accepted'); } catch(error) { outcomes.push(error.message); }
      }
      return outcomes;
    }, { provider, model: provider === 'openai' ? 'gpt-image-2.5-flare' : relayModel, apiKey: fakeRelayKey });
    assert.deepEqual(result, Array(4).fill('官方直连和旧生图中转已退役；新生图仅支持 OpenRouter'));
  }
  for (const model of ['gemini-nano-banana-2.1', 'gemini-3-pro-image-preview', 'gemini-3.1-flash-image-preview', 'future-image-v3']) {
    await assert.rejects(page.evaluate(model => window.red.saveImageGenerationConnection({provider:'openrouter', model, enabled:true}), model));
  }
  assert.equal((await calls()).length, beforeLegacy);
  for (const filename of ['openai-images.bin', 'tyai-images.bin']) await assert.rejects(readFile(join(dataRoot,'ai-vault',filename)), {code:'ENOENT'});
  pass('legacy provider UI is absent; real IPC rejects legacy reads/writes/checks/disconnects and Gemini/custom activation before any transport');

  const { readCandidateFiles } = await import('../src/main/image-generation/candidate.ts');
  const { createHistoricalImageReader } = await import('../src/main/image-generation/history-reader.ts');
  const { randomUUID } = await import('node:crypto');
  const historyIds = [];
  for (const [provider, model] of [['openai','gpt-image-2.5-flare'], ['tyai',relayModel], ['tyai','gemini-3.1-flash-image-preview']]) {
    const id = randomUUID(), directory = join(dataRoot,'image-generation','candidates',id);
    await mkdir(directory);
    const original = join(dataRoot,'image-generation','candidates',generated.id);
    const metadata = JSON.parse(await readFile(join(original,'candidate.json'),'utf8'));
    await writeFile(join(directory,'candidate.json'),JSON.stringify({...metadata,id,provider,model}));
    for (const file of ['image.png','preview.png']) await writeFile(join(directory,file),await readFile(join(original,file)));
    const history = await readCandidateFiles(dataRoot,id);
    assert.equal(history.candidate.provider,provider); assert.equal(history.candidate.model,model);
    const materialized = await createHistoricalImageReader()({data:[{b64_json:history.bytes.toString('base64')}]},new AbortController().signal);
    assert.deepEqual(materialized.bytes,history.bytes); historyIds.push(id);
  }
  pass('synthetic historical official/Tyai/Gemini candidate provenance and response readers remain readable without credentials or generation');
  await click(button('断开 OpenRouter')); await expect(badge()).toHaveText('未配置'); await expect(keyInput()).toHaveValue('');
  assert.deepEqual(await connection(), absent); await assert.rejects(readFile(vaultFile), { code: 'ENOENT' });
  await assert.rejects(readFile(join(dataRoot,'ai-vault','openrouter.bin')), {code:'ENOENT'});
  assert.equal((await page.evaluate(() => window.red.listAiCapabilities())).find(item => item.capability === 'image-generation').available, false);
  await rejected(input, 'AI 凭据不可用，请在设置中重新填写或导入配置');
  assert.equal((await calls()).length, beforeLegacy);
  assertPrivate(await page.evaluate(() => ({ text: document.body.innerText, localStorage: { ...localStorage }, sessionStorage: { ...sessionStorage } })));
  await close(); await launch(); await settings();
  assert.deepEqual(await connection(), absent); await expect(enableInput()).not.toBeChecked();
  assert.deepEqual(await candidateDirectories(), [generated.id, edited.id, ...historyIds].sort()); assert.deepEqual(await calls(), []);
  for (const id of historyIds) assert.ok((await readCandidateFiles(dataRoot,id)).bytes.length);
  await close();
  assert.deepEqual(sessions.flatMap(session => session.unexpected), []);
  assert.deepEqual(sessions.flatMap(session => session.remoteRequests), []);
  assert.deepEqual(sessions.flatMap(session => session.shownWindows), []);
  assert.deepEqual(errors, []); assertPrivate(processLog); assertPrivate(sessions);
  pass('disconnect clears shared OpenRouter credential across restart, preserves historical candidates, and makes zero real HTTP(S), unexpected requests or visible windows');
  succeeded = true;
} catch (error) {
  failure = error.stack || String(error); console.error(failure);
  if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
} finally {
  await close().catch(error => { errors.push(`cleanup: ${error.message}`); succeeded = false; });
  const report = { passed: succeeded, startedAt, finishedAt: new Date().toISOString(), dataRoot, build, checks, candidates, layouts, screenshots, sessions, errors, failure, processLog,
    environment: 'separate permanently hidden Electron; real production preload/IPC/local services/safeStorage; fake key; main net.fetch mock; HTTP(S) blocked; no window.red mocks; no production data' };
  const serialized = JSON.stringify(report, null, 2).replaceAll(fakeKey, '[REDACTED FAKE KEY]').replaceAll(fakeRelayKey, '[REDACTED FAKE RELAY KEY]').replaceAll(privateMarker, '[REDACTED UPSTREAM DETAIL]') + '\n';
  const reportPath = join(artifacts, `${build.packaged ? 'packaged-' : ''}image-generation-e2e-report.json`);
  await writeFile(reportPath, serialized);
  await writeFile(join(artifacts, `${artifactPrefix}-e2e-report-${startedAt.replace(/[:.]/g, '-')}.json`), serialized);
  console.log(`REPORT ${reportPath}`);
  if (!succeeded) process.exitCode = 1;
}
