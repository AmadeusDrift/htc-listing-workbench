import { _electron as electron } from 'playwright';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { readStreamingBackup } from '../src/main/backup-stream.ts';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { resizeWindow } from './e2e-window.mjs';

// Real production entry, renderer, preload, IPC, safeStorage and local services.
// Install transport mocks before AiService captures fetch. Packaged applications
// ignore -r, so their unchanged main entry is paused using a local inspector.
// No window.red method, service, product code or delivered file is replaced.
const root = resolve('.'), artifacts = resolve('artifacts');
await mkdir(resolve('.test-data'), { recursive: true });
await mkdir(artifacts, { recursive: true });
const dataRoot = await mkdtemp(resolve('.test-data/automatic-images-e2e-'));
const require = createRequire(import.meta.url), executablePath = process.env.RED_E2E_EXECUTABLE || require('electron');
const buildRoot = process.env.RED_E2E_EXECUTABLE ? join(dirname(resolve(executablePath)), 'resources', 'app') : root;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const build = { packaged: Boolean(process.env.RED_E2E_EXECUTABLE), version: JSON.parse(await readFile(join(buildRoot, 'package.json'), 'utf8')).version,
  mainSha256: sha256(await readFile(join(buildRoot, 'dist-electron/main.cjs'))), preloadSha256: sha256(await readFile(join(buildRoot, 'dist-electron/preload.cjs'))) };
const fakeKeys = { deepseek: 'automatic-e2e-fake-deepseek-key', image: 'automatic-e2e-fake-image-key', accessId: 'automatic-e2e-fake-access-id', accessSecret: 'automatic-e2e-fake-access-secret' };
const checks = [], runs = [], sessions = [], screenshots = [], layouts = [], backups = [], errors = [], processLog = [];
const startedAt = new Date().toISOString();
const scope = process.env.RED_E2E_FULL_SCHEMA_ONLY === '1' ? 'full-schema-seven-images' : 'all-image-cases';
let app, page, succeeded = false, failure = null;
const pass = message => { checks.push(message); console.log(`PASS ${message}`); };

function installMockTransport(keys) {
  const { app, BrowserWindow, nativeImage, net, session } = require('electron');
  const { createHash } = require('node:crypto');
  const assert = require('node:assert/strict');
  const state = globalThis.__automaticImagesE2E = { mode: 'pass', imageCount: 0, holdAttempt: 0, pending: [], calls: [], unexpected: [], remoteRequests: [], shownWindows: [] };
  // Source downloads use Node HTTPS, not fetch. The demo receipt supplies local
  // fixture bytes; fail closed if any production path tries a real Node request.
  for (const transport of ['node:http', 'node:https']) for (const method of ['request', 'get']) {
    require(transport)[method] = url => { state.unexpected.push({ transport: `${transport}.${method}`, url: String(url) }); throw Error('Real Node HTTP(S) is forbidden in this isolated test'); };
  }
  require('node:module').syncBuiltinESMExports();
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', 'x-request-id': `automatic-image-${state.calls.length}` } });
  const chat = value => response({ id: `automatic-chat-${state.calls.length}`, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
  const png = seed => {
    const size = 1024, bitmap = Buffer.alloc(size * size * 4);
    for (let offset = 0; offset < bitmap.length; offset += 4) { bitmap[offset] = 71 + seed; bitmap[offset + 1] = 156; bitmap[offset + 2] = 219; bitmap[offset + 3] = 255; }
    return nativeImage.createFromBitmap(bitmap, { width: size, height: size }).toPNG();
  };
  state.sourcePng = seed => png(seed).toString('base64');
  const observe = window => {
    window.webContents.setBackgroundThrottling(false);
    if (window.isVisible()) state.shownWindows.push(window.id);
    window.on('show', () => state.shownWindows.push(window.id));
  };
  app.on('browser-window-created', (_event, window) => observe(window));
  void app.whenReady().then(() => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.setBackgroundThrottling(false);
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      state.remoteRequests.push(details.url); callback({ cancel: true });
    });
  });
  const dispatch = async (transport, url, options = {}) => {
    const address = String(url), call = { transport, url: address, mode: state.mode, kind: '', aborted: false };
    state.calls.push(call);
    options.signal?.addEventListener('abort', () => { call.aborted = true; }, { once: true });
    if (address === 'https://api.deepseek.com/chat/completions') {
      const body = JSON.parse(options.body), content = body.messages[1].content, payload = JSON.parse(Array.isArray(content) ? content[0].text : content);
      call.kind = payload.operation && payload.operation !== 'amazon-fields' ? payload.operation : (payload.candidate ? 'listing-fields-review' : 'listing-fields');
      call.evidence = payload.evidence?.map(({ name, value, source }) => ({ name, value, source }));
      call.model = body.model;
      if (new Headers(options.headers).get('authorization') !== `Bearer ${keys.deepseek}`) throw Error('Unexpected test text credential');
      const idsFor = field => payload.evidence.filter(value => !['color', 'material'].includes(field) || value.meaning === field).map(value => value.id);
      if(call.kind==='source-image-consistency'){
        assert.equal(body.model,'deepseek-flash'); assert.ok(Array.isArray(content));
        const hashes=content.filter(part=>part.type==='image_url').map(image=>digest(Buffer.from(image.image_url.url.split(',')[1],'base64')));
        assert.deepEqual(hashes,payload.referenceAssets.map(asset=>asset.sha256)); call.referenceHashes=hashes;
        return chat({kind:'source-image-consistency',version:'source-image-consistency/v2',assets:payload.referenceAssets.map(asset=>({assetId:asset.assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:[],appearance:['Visible synthetic product fixture'],claims:[],contentPurpose:'product',observations:[]}))});
      }
      if (call.kind === 'image-plan') {
        call.repair = Boolean(payload.repair);
        assert.equal(body.model, 'deepseek-flash'); assert.ok(Array.isArray(content));
        const images = content.filter(part => part.type === 'image_url');
        assert.equal(images.length, payload.referenceImages.length); assert.ok(images.length > 0);
        call.referenceHashes = images.map((image, index) => {
          assert.equal(image.image_url.detail, 'original');
          assert.match(image.image_url.url, /^data:image\/(png|jpeg);base64,/);
          const bytes = Buffer.from(image.image_url.url.split(',')[1], 'base64'), decoded = nativeImage.createFromBuffer(bytes);
          assert.equal(decoded.isEmpty(), false); assert.deepEqual(decoded.getSize(), { width: payload.referenceImages[index].width, height: payload.referenceImages[index].height });
          assert.equal(digest(bytes), payload.referenceImages[index].sha256); return digest(bytes);
        });
        call.visualSummary = 'Blue product with the shape and components shown in the source reference';
        call.sufficient = state.mode !== 'vision-unclear';
        const ipRisk = state.mode === 'ip-source' ? { verdict: 'BLOCKED', findings: [{ category: 'character', name: '测试知名角色', evidence: '来源图中有可辨识的角色面部与标志性服装。', referenceAssetIds: [payload.referenceImages[0].assetId] }] } : { verdict: 'PASS', findings: [] };
        return chat({ ...(payload.setPolicy&&!payload.slot?{setPlan:{style:'Natural light and warm neutral surfaces.',dimensionEvidenceIds:[],dimensionReason:'No verified dimensions in this fixture.',slots:Array.from({length:7},(_,i)=>({index:i+1,role:i===0?'main_scene':'scene',focus:'Daily scene '+(i+1),evidenceIds:[],scene:'Distinct tabletop setting '+(i+1),prompt:'Show the actual source product in a realistic scene '+(i+1),textMode:'none',expectedText:[]}))}}:{}), kind: 'image-plan', ipRisk, productUnderstanding: { summary: call.visualSummary, referenceAssetIds: payload.referenceImages.map(image => image.assetId), uncertainties: call.sufficient ? ['Exact size is unknown from the photograph.'] : ['来源图片无法确认当前 SKU。'], sufficient: call.sufficient }, prompt: 'Use only the supplied reference product. Preserve its color, construction and count. Realistic tabletop use scene. No added text, words, labels or marks.', textMode: 'none', expectedText: [] });
      }
      if (call.kind === 'image-appearance-review') {
        assert.equal(body.model,'deepseek-flash'); assert.ok(Array.isArray(content));
        const images=content.filter(part=>part.type==='image_url');
        assert.equal(images.length,payload.referenceImages.length+1);
        const hashes=images.map(image=>digest(Buffer.from(image.image_url.url.split(',')[1],'base64')));
        assert.deepEqual(hashes.slice(0,-1),payload.referenceImages.map(image=>image.sha256));
        assert.equal(hashes.at(-1),payload.candidate.sha256);
        assert.ok(state.calls.some(prior=>prior.kind==='image-generation'&&prior.imageSha256===hashes.at(-1)));
        call.referenceHashes=hashes; call.candidateSha256=payload.candidate.sha256;
        return chat({verdict:'PASS',checks:[{aspect:'identity',expected:'Fixture coaster from selected SKU',observed:'Matching synthetic fixture coaster',reason:'Deterministic appearance fixture; source and candidate bytes verified',referenceAssetIds:payload.referenceImages.map(image=>image.assetId)}]});
      }
      if (call.kind === 'image-text-review') {
        const text = payload.unverifiedOcr.text;
        const evidenceIds=payload.evidence.filter(value=>value.meaning==='color').map(value=>value.id);
        return chat(text ? { verdict: 'NEEDS_CHANGES', checks: [{ source: 'summary', index: 0, text, verdict: 'CONTRADICTED', evidenceIds, reason: 'OCR Red contradicts verified Blue; expected Blue.' },
          ...payload.unverifiedOcr.lines.map((line, index) => ({ source: 'line', index, text: line.text, verdict: 'CONTRADICTED', evidenceIds, reason: 'OCR Red contradicts verified Blue; expected Blue.' }))], expectedTextChecks: [], noTextVerified: false, issues: ['图片第 0 行 Red 与已确认颜色 Blue 矛盾，应改为 Blue。'] }
          : { verdict: 'PASS', checks: [], expectedTextChecks: [], noTextVerified: true, issues: [] });
      }
      if (call.kind === 'listing-current-review' && !payload.evidence.some(value => value.name === '产品类型')) {
        const reason = '原始演示标题与说明没有已确认的商品事实支持。';
        return chat({ kind: 'amazon-fields-review', verdict: 'BLOCKED', checks: payload.candidate.candidates.flatMap(candidate => candidate.items.map((item, index) => ({
          field: candidate.field, index, verdict: 'UNSUPPORTED', evidenceIds: [], reason,
          claims: [{ text: item.value, verdict: 'UNSUPPORTED', evidenceIds: [], reason }],
        }))), issues: payload.candidate.candidates.map(candidate => ({ field: candidate.field, message: reason })) });
      }
      if (payload.candidate) return chat({ kind: 'amazon-fields-review', verdict: 'PASS', checks: payload.candidate.candidates.flatMap(candidate => candidate.items.map((item, index) => {
        const evidenceIds = item.evidenceIds || idsFor(candidate.field);
        return { field: candidate.field, index, verdict: 'SUPPORTED', evidenceIds, reason: 'Matches confirmed product and selected SKU facts.', claims: [{ text: item.value, verdict: 'SUPPORTED', evidenceIds, reason: 'Matches the supplied facts.' }] };
      })), issues: [] });
      const color = payload.evidence.find(value => value.meaning === 'color') ?? payload.evidence.find(value => value.name === 'Selected SKU specification'), material = payload.evidence.find(value => value.meaning === 'material');
      const productType = payload.evidence.find(value => value.name === '产品类型');
      const title = productType && `${material ? `${material.value} ` : ''}${productType.value}`;
      const values = { color: color && ({ 米白: 'Off White', 灰色: 'Gray' }[color.value] || color.value), material: material?.value,
        item_name: title, product_description: title && `A ${title.toLowerCase()}.` };
      return chat({ kind: 'amazon-fields', ...(payload.contract?{contract:payload.contract}:{}), candidates: payload.fields.filter(field => values[field.name]).map(field => {
        if(payload.contract==='listing-full-schema/v1'){
          const schema=payload.fullSchema.schema.properties[field.name],props=schema.items?.properties,value=values[field.name];
          const nativeValue=schema.type==='array'?[props?{value,...(props.marketplace_id?{marketplace_id:payload.marketplaceId}:{}),...(props.language_tag?{language_tag:payload.locale}:{})}:value]:value;
          return {field:field.name,nativeValue,evidenceIds:idsFor(field.name),transformation:'compose'};
        }
        return { field: field.name, items: [{ value: values[field.name], evidenceIds: idsFor(field.name), transformation: 'compose' }] };
      }),
        missing: payload.fields.filter(field => !values[field.name]).map(field => ({ field: field.name, reason: 'No fixture evidence for this field.' })) });
    }
    if (address === 'https://green-cip.cn-shanghai.aliyuncs.com/') {
      const action = new Headers(options.headers).get('x-acs-action');
      assert.ok(new Headers(options.headers).get('authorization').includes(keys.accessId));
      if (action === 'DescribeUploadToken') {
        call.kind = 'ip-token';
        return response({ Code: 200, Data: { AccessKeyId: 'e2e-temporary-id', AccessKeySecret: 'e2e-temporary-secret', SecurityToken: 'e2e-temporary-token', BucketName: 'oss-cip-shanghai', FileNamePrefix: 'upload/isolated/', OssInternetEndPoint: 'https://oss-cn-shanghai.aliyuncs.com', Expiration: Math.floor(Date.now()/1000)+1800 } });
      }
      assert.equal(action, 'ImageModeration'); call.kind = 'ip-check';
      const body = new URLSearchParams(Buffer.from(options.body).toString()); assert.equal(body.get('Service'), 'aigcViolationDetection');
      const parameters = JSON.parse(body.get('ServiceParameters'));
      assert.equal(parameters.ossBucketName, 'oss-cip-shanghai'); assert.equal(parameters.ossRegionId, 'cn-shanghai');
      assert.equal(parameters.ossObjectName, `upload/isolated/${parameters.dataId}.png`);
      call.imageSha256 = state.calls.findLast(previous => previous.kind === 'ip-upload').imageSha256;
      assert.ok(state.calls.some(previous => previous.kind === 'image-generation' && previous.imageSha256 === call.imageSha256), 'Moderation must inspect known generated bytes, including an existing image during recheck');
      if (state.mode === 'ip-unavailable') return response({ Code: 408, RequestId: 'service-not-opened', Message: 'Synthetic unopened service' });
      return response({ Code: 200, RequestId: `automatic-ip-${state.calls.length}`, Data: { DataId: parameters.dataId, RiskLevel: state.mode === 'ip-generated' ? 'high' : 'none', Result: state.mode === 'ip-generated' ? [{ Label: 'trademark', Description: '检测到疑似品牌标识' }] : [{ Label: 'nonLabel', Description: '未检出风险' }] } });
    }
    if (address.startsWith('https://oss-cip-shanghai.oss-cn-shanghai.aliyuncs.com/upload/isolated/')) {
      call.kind = 'ip-upload'; call.imageSha256 = digest(Buffer.from(options.body));
      assert.equal(options.method, 'PUT'); assert.equal(options.redirect, 'error');
      assert.ok(new Headers(options.headers).get('authorization').includes('e2e-temporary-id'));
      assert.ok(state.calls.some(previous => previous.kind === 'image-generation' && previous.imageSha256 === call.imageSha256), 'Risk upload must use known generated bytes, including an existing image during recheck');
      return new Response(null, { status: 200 });
    }
    if (address.startsWith('https://ocr-api.cn-hangzhou.aliyuncs.com/')) {
      call.kind = state.imageCount===0?'source-ocr':'ocr'; call.imageSha256 = digest(Buffer.from(options.body));
      const text = state.mode === 'blocked' || state.mode === 'repair' && state.imageCount === 1 ? 'Red' : '';
      return response({ Code: 'success', RequestId: `automatic-ocr-${state.calls.length}`, Data: { Width: 1024, Height: 1024, Content: text,
        SubImageCount: text ? 1 : 0, SubImages: text ? [{ SubImageId: 0, BlockInfo: { BlockCount: 1, BlockDetails: [{ BlockId: 0, BlockContent: text, BlockConfidence: 99 }] } }] : [] } });
    }
    if (address === 'https://openrouter.ai/api/v1/images' && options.method === 'POST') {
      call.kind = 'image-generation'; call.attempt = ++state.imageCount;
      if (new Headers(options.headers).get('authorization') !== `Bearer ${keys.image}`) throw Error('Unexpected test image credential');
      const body = JSON.parse(options.body); call.model = body.model; call.prompt = body.prompt;
      assert.equal(body.model, 'openai/gpt-image-2.5-sunburst');
      assert.deepEqual(body.provider, { only: ['openai'], allow_fallbacks: false });
      call.referenceHashes = body.input_references.map(image => digest(Buffer.from(image.image_url.url.split(',')[1], 'base64')));
      const plan = state.calls.findLast(previous => previous.kind === 'image-plan');
      assert.equal(plan?.sufficient, true); assert.deepEqual(plan.repair?call.referenceHashes.slice(1):call.referenceHashes, plan.referenceHashes);
      assert.ok(call.prompt.includes(plan.visualSummary)); assert.ok(call.prompt.includes('Exact size is unknown'));
      if (state.mode === 'network-error') throw Error('Synthetic ambiguous provider disconnect');
      if (state.holdAttempt === state.imageCount) await new Promise((done, reject) => {
        const finish = () => { options.signal?.removeEventListener('abort', abort); done(); };
        const abort = () => reject(Error('Synthetic request cancelled'));
        state.pending.push(finish); options.signal?.addEventListener('abort', abort, { once: true });
      });
      const bytes = png(100 + state.imageCount); call.imageSha256 = digest(bytes);
      return response({ created: 1791417600, data: [{ b64_json: bytes.toString('base64') }] });
    }
    state.unexpected.push({ transport, url: address }); throw Error('Network access is forbidden outside the isolated provider fixtures');
  };
  globalThis.fetch = (url, options) => dispatch('global-fetch', url, options);
  net.fetch = (url, options) => dispatch('electron-net', url, options);
}

// Keep the hook outside the restored directory so restart uses the same safety
// boundary even after the workspace root has been atomically replaced.
const bootstrap = join(await mkdtemp(resolve('.test-data/automatic-images-harness-')), 'transport-bootstrap.cjs');
await writeFile(bootstrap, `(${installMockTransport.toString()})(${JSON.stringify(fakeKeys)});\n`);
const env = { ...process.env, RED_DATA_DIR: dataRoot, RED_E2E: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.RED_DEV_SERVER_URL; delete env.RED_COLLECTION_TEST_HOST;
process.env.electron_config_cache = resolve('.cache/electron');

async function debuggerPort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
  return port;
}
async function installBeforePackagedEntry(port) {
  const deadline = Date.now() + 15000;
  let endpoint;
  while (!endpoint && Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
      endpoint = targets.find(target => target.type === 'node')?.webSocketDebuggerUrl;
    } catch { /* Wait only for the new test process's loopback inspector. */ }
    if (!endpoint) await delay(50);
  }
  assert.ok(endpoint?.startsWith(`ws://127.0.0.1:${port}/`), 'The isolated packaged main must expose its own loopback inspector');
  const socket = new WebSocket(endpoint), pending = new Map();
  let nextId = 0, pausedResolve;
  const paused = new Promise(done => { pausedResolve = done; });
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.method === 'Debugger.paused') pausedResolve(message.params);
    if (message.id && pending.has(message.id)) {
      const { done, reject, timer } = pending.get(message.id); pending.delete(message.id); clearTimeout(timer);
      if (message.error) reject(Error(JSON.stringify(message.error))); else done(message.result);
    }
  });
  await new Promise((done, reject) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', () => reject(Error('Could not connect to the isolated main inspector')), { once: true }); });
  const send = (method, params = {}) => new Promise((done, reject) => {
    const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(Error(`Main inspector timed out: ${method}`)); }, 10000);
    pending.set(id, { done, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    await send('Runtime.enable'); await send('Debugger.enable');
    await send('Runtime.runIfWaitingForDebugger');
    let pauseTimer;
    try { await Promise.race([paused, new Promise((_done, reject) => { pauseTimer = setTimeout(() => reject(Error('The packaged main did not pause before execution')), 10000); })]); }
    finally { clearTimeout(pauseTimer); }
    const identity = await send('Runtime.evaluate', { expression: '({ dataRoot: process.env.RED_DATA_DIR, executable: process.execPath })', returnByValue: true, includeCommandLineAPI: true });
    assert.equal(identity.result.value.dataRoot, dataRoot);
    assert.equal(resolve(identity.result.value.executable).toLowerCase(), resolve(executablePath).toLowerCase(), 'Only the test-launched delivery EXE may be instrumented');
    const installed = await send('Runtime.evaluate', { expression: `require(${JSON.stringify(bootstrap)}); Boolean(globalThis.__automaticImagesE2E)`, returnByValue: true, includeCommandLineAPI: true });
    if (installed.exceptionDetails) throw Error(installed.exceptionDetails.exception?.description || 'Main transport bootstrap failed');
    assert.equal(installed.result.value, true, 'The mock must exist before the packaged product entry resumes');
    await send('Debugger.resume');
  } finally {
    // Also release failed test launches so Electron can close normally. The
    // empty isolated workspace has no credentials and has received no action.
    await send('Debugger.resume').catch(() => {});
    socket.close();
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(Error('Main inspector closed')); }
    pending.clear();
  }
}
async function launch() {
  // Playwright removes NODE_OPTIONS. Dev Electron accepts -r; the delivery EXE
  // uses its own entry, so install the hook while that main thread is paused.
  const port = build.packaged ? await debuggerPort() : null;
  const launching = electron.launch({ executablePath, args: port ? [`--inspect-brk=127.0.0.1:${port}`] : ['-r', bootstrap, '.'], cwd: root, env, timeout: 35000 });
  if (port) {
    try { await installBeforePackagedEntry(port); }
    catch (error) { const failed = await launching.catch(() => null); await failed?.close(); throw error; }
  }
  app = await launching;
  app.process().stderr.on('data', chunk => processLog.push(chunk.toString()));
  assert.equal(await app.evaluate(() => Boolean(globalThis.__automaticImagesE2E)), true, 'Provider transports must be blocked before any fake credentials are configured');
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await expect(page.getByRole('button', { name: '新建商品', exact: true })).toBeEnabled();
  assert.equal((await page.evaluate(() => window.red.getSettings())).dataDirectory, dataRoot);
  for (const method of ['prepareAutomaticProductSources', 'cancelAutomaticProductSources', 'completeAutomaticProduct', 'getAutomaticProductProgress', 'cancelAutomaticProduct', 'getCopyReviewSettings', 'saveCopyReviewSettings']) assert.equal(await page.evaluate(name => typeof window.red[name], method), 'function');
  await assertHidden();
}
async function assertHidden() {
  const value = await app.evaluate(({ BrowserWindow }) => ({ visible: BrowserWindow.getAllWindows().some(window => window.isVisible()), shown: globalThis.__automaticImagesE2E?.shownWindows ?? [] }));
  assert.equal(value.visible, false); assert.deepEqual(value.shown, []);
}
async function close() {
  if (!app) return;
  try {
    await assertHidden();
    const session = await app.evaluate(() => { const state = globalThis.__automaticImagesE2E; if (!state) return null; const { calls, unexpected, remoteRequests, shownWindows } = state; return { calls, unexpected, remoteRequests, shownWindows }; });
    if (session) sessions.push(session);
  } finally { await app.close(); app = null; page = null; }
}
async function click(locator) { await expect(locator).toBeVisible(); await expect(locator).toBeEnabled(); await locator.click({ force: true }); }
const button = name => page.getByRole('button', { name, exact: true });
const panel = () => page.getByRole('region', { name: '启动自动上架', exact: true });
async function chooseFile(path) { await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, path); }
async function configure() {
  await page.evaluate(async keys => {
    await window.red.saveAiConnection({ id: 'deepseek', apiKey: keys.deepseek });
    await window.red.saveAiFunctionSettings({ id: 'deepseek', model: 'deepseek-flash', enabled: true });
    await window.red.saveAiFunctionSettings({ id: 'deepseek-review', model: 'deepseek-v4-pro', enabled: true });
    await window.red.saveAiConnection({ id: 'aliyun', accessKeyId: keys.accessId, accessKeySecret: keys.accessSecret });
    await window.red.saveAiFunctionSettings({ id: 'aliyun-ocr', model: 'RecognizeAllText/Commerce', enabled: true });
    await window.red.saveAiFunctionSettings({ id: 'aliyun-image-risk', model: 'aigcViolationDetection', enabled: true });
    await window.red.saveImageGenerationConnection({ provider: 'openrouter', apiKey: keys.image, model: 'openai/gpt-image-2.5-sunburst', enabled: true, size: '1024x1024', quality: 'high' });
    // API-R2 purpose routes are explicit and no longer inherited from old role
    // settings. Preserve this suite's deterministic DeepSeek text fixtures.
    for (const profile of await window.red.getAiPurposeProfiles()) {
      if (profile.purposeId.endsWith('_decision')) continue;
      const review = ['copy_review','copy_review_difficult','image_text_review'].includes(profile.purposeId);
      await window.red.saveAiPurposeProfile({purposeId:profile.purposeId,expectedRevision:profile.revision,
        patch:{gateway:'deepseek',model:review?'deepseek-v4-pro':'deepseek-flash',effort:'none'}});
    }

  }, fakeKeys);
}
async function createProduct(label) {
  let product = await page.evaluate(async label => {
    const created = await window.red.createProduct(), variant = created.variants[0];
    const saved = await window.red.saveProduct({ id: created.id, revision: created.revision, title: 'Silicone Coaster', description: 'A silicone coaster.', sourceUrl: '', status: 'draft',
      variants: [{ ...variant, sku: `AUTO-${label}-BLUE`, originalSpec: 'Blue', normalizedSpec: 'Blue', purchasePrice: '1', inventory: 10 },
        { id: crypto.randomUUID(), sku: `AUTO-${label}-RED`, originalSpec: 'Red', normalizedSpec: 'Red', purchasePrice: '1', inventory: 10 }].map(({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory }) => ({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory })),
      facts: [['材质', 'Silicone'], ['产品类型', 'Coaster']].map(([name, value]) => ({ id: crypto.randomUUID(), name, value, source: 'manual', sourceRef: 'isolated fixture', state: 'human_confirmed' })) });
    await window.red.moveWorkspaceProducts({ productIds: [saved.id], destination: 'automatic' });
    return saved;
  }, label);
  const sourceHashes = [];
  for (let index = 0; index < 2; index++) {
    const path = join(dataRoot, `${label}-reference-${index}.png`), bytes = Buffer.from(await app.evaluate((_electron, seed) => globalThis.__automaticImagesE2E.sourcePng(seed), index + 1), 'base64');
    sourceHashes.push(sha256(bytes)); await writeFile(path, bytes); await chooseFile(path);
    const oldIds = product.assets.map(asset => asset.id);
    product = await page.evaluate(input => window.red.importImages(input), { productId: product.id, revision: product.revision });
    const asset = product.assets.find(asset => !oldIds.includes(asset.id)); assert.ok(asset);
    product = await page.evaluate(input => window.red.updateAsset(input), { productId: product.id, revision: product.revision, assetId: asset.id, role: index ? 'gallery' : 'main', variantIds: [product.variants[index].id] });
  }
  await page.evaluate(async product=>{for(const variant of product.variants){const input={productId:product.id,productRevision:product.revision,variantId:variant.id},view=await window.red.getSourceConsistency(input);await window.red.decideSourceConsistency({...input,fingerprint:view.fingerprint,decision:'CONFIRMED',reason:'Synthetic image workflow fixture: checked original image correspondence for this test.'});}},product);
  return { product, sourceHashes };
}
async function importRemoteProduct() {
  const source = await page.evaluate(async () => {
    await window.red.saveMiaoshouPreferences({ autoSyncOnInbox: false });
    await window.red.setMiaoshouMode('demo');
    const listed = await window.red.listMiaoshouProducts({ pageNo: 1, pageSize: 20 });
    const item = listed.items.find(item => item.id === 'demo-colors');
    if (!item) throw Error('The demo remote product is missing');
    const preview = await window.red.previewMiaoshouProduct({ id: item.id });
    const dimensions = { 'bag-01': ['tone-a', 'fit-a'], 'bag-02': ['tone-b', 'fit-a'], 'bag-03': ['tone-a', 'fit-b'], 'bag-04': ['tone-b', 'fit-b'] };
    const imported = await window.red.importMiaoshouProduct({ previewId: preview.previewId, mapping: { priceField: 'price', currency: 'CNY',
      skus: preview.product.skus.map(sku => ({ sourceKey: sku.key, dimensions: { color: dimensions[sku.key][0], size: dimensions[sku.key][1] } })) } });
    await window.red.moveWorkspaceProducts({ productIds: [imported.productId], destination: 'automatic' });
    return { product: await window.red.getProduct(imported.productId), receipt: await window.red.getMiaoshouReceipt(imported.productId) };
  });
  assert.equal(source.product.assets.length, 0, 'An untouched Miaoshou import must start with source URLs only');
  assert.equal(source.product.facts.length, 0, 'The raw demo must not gain invented confirmed product facts');
  assert.equal(source.receipt.mode, 'demo');
  assert.ok(source.receipt.snapshot.images.length > 0 && source.receipt.snapshot.images.every(image => image.url.startsWith('https://demo.invalid/miaoshou/')));
  return source;
}
async function selectProduct(product, targetId) {
  await page.reload(); await expect(button('新建商品')).toBeEnabled();
  await click(page.locator('nav').getByRole('button', { name: '自动上架', exact: true }));
  const selection=panel().getByTestId(`automatic-select-${product.id}`);
  // The twelve-product restore fixture spans two current eight-row pages.
  // Select through the real pagination UI instead of assuming the oldest row
  // remains on page one after reload/restore.
  if(await selection.count()===0)await click(panel().getByRole('button',{name:'下一页',exact:true}));
  await selection.check({ force: true });
  await panel().getByRole('combobox', { name: /目标店铺与站点/ }).selectOption(targetId);
  assert.equal(await panel().locator('textarea').count(), 0);
  assert.equal(await panel().getByRole('textbox', { name: /提示词|参考图/ }).count(), 0);
}
async function scenario(source, targetId, mode, expected, holdAttempt = 0) {
  const { product } = source;
  {
    // The standard demo intentionally does not apply Haul price/brand defaults.
    // Seed those business inputs while leaving color missing for the real AI
    // completion path. Image prompts and references are always selected by IPC.
    const prepared = await page.evaluate(({ product, targetId }) => window.red.prepareAmazonDrafts({ targetId, productType: 'HTC_DEMO_STORAGE_BAG', parentageLevel: 'NONE', requirements: 'LISTING', locale: 'en_US', listingProgram: 'standard',
      items: [{ productId: product.id, productRevision: product.revision, variantId: product.variants[0].id, attributes: { brand: [{ value: 'Generic', marketplace_id: 'ATVPDKIKX0DER' }],
        purchasable_offer: [{ marketplace_id: 'ATVPDKIKX0DER', currency: 'USD', audience: 'ALL', our_price: [{ schedule: [{ value_with_tax: 2.5 }] }] }] } }] }), { product, targetId });
    assert.ok(prepared.items[0].draft);
  }
  await selectProduct(product, targetId);
  await app.evaluate((_electron, input) => { const state = globalThis.__automaticImagesE2E; state.mode = input.mode; state.imageCount = 0; state.holdAttempt = input.holdAttempt; state.pending = []; }, { mode, holdAttempt });
  const before = await app.evaluate(() => globalThis.__automaticImagesE2E.calls.length);
  const draftId = await beginImageWorkflow(product, targetId);
  if (holdAttempt) {
    await expect.poll(async () => { const run = await page.evaluate(id => window.red.getAutomaticProductProgress(id), draftId); return run?.stage === 'generating' ? run.attempt : 0; }, { timeout: 30000 }).toBe(holdAttempt);
    await expect.poll(() => app.evaluate(() => globalThis.__automaticImagesE2E.pending.length), { timeout: 30000 }).toBeGreaterThan(0);
    if (mode === 'cancel') await page.evaluate(id => window.red.cancelAutomaticProduct(id), draftId);
    else await app.evaluate(() => { for (const done of globalThis.__automaticImagesE2E.pending.splice(0)) done(); });
  }
  const result = await page.evaluate(() => globalThis.__imageWorkflowPromise);
  assert.equal(result.workflow.status, { done: 'COMPLETED', blocked: 'BLOCKED', failed: 'FAILED', stopped: 'CANCELLED' }[expected]);
  const drafts = await page.evaluate(id => window.red.listAmazonDrafts(id), product.id);
  assert.equal(drafts.length, 1, 'The configured variant limit leaves the second SKU untouched');
  const workflow = await page.evaluate(id => window.red.getAutomaticProductProgress(id), drafts[0].id);
  const calls = await app.evaluate((_electron, before) => globalThis.__automaticImagesE2E.calls.slice(before), before);
  runs.push({ mode, productId: product.id, draftId: drafts[0].id, workflow, calls });
  for (const call of calls.filter(call => ['image-generation','image-plan'].includes(call.kind))) {
    assert.deepEqual(call.referenceHashes.slice(-1), [source.sourceHashes[0]], 'Original SKU reference remains attached');
    if(call.referenceHashes.length===2)assert.ok(calls.some(prior=>prior.kind==='image-generation'&&prior.imageSha256===call.referenceHashes[0]),'An extra editing reference must be a prior failed candidate');
  }
  assert.ok(calls.filter(call => call.evidence).every(call => !call.evidence.some(evidence => evidence.value === 'Red')));
  const current = await page.evaluate(id => window.red.getProduct(id), product.id);
  assert.equal(current.revision, product.revision, 'Derived adoption must not change source revision');
  assert.deepEqual(current.assets.filter(asset => product.assets.some(original => original.id === asset.id)), product.assets);
  assert.equal(drafts[0].submittedAt, null);
  return { ...source, draft: drafts[0], workflow, calls, current };
}
// The old preparation UI has been replaced by a persistent publishing task.
// Exercise the unchanged image IPC directly here so these image-only cases
// never publish; the new UI and coordinator have their own integration suites.
async function beginImageWorkflow(product, targetId) {
  return page.evaluate(async ({ product, targetId }) => {
    const current = await window.red.getProduct(product.id);
    const sources = await window.red.prepareAutomaticProductSources({ productId: current.id, productRevision: current.revision, variantIds: [current.variants[0].id] });
    if (sources.missing.length) throw Error(sources.missing[0].message);
    // The current application requires source observations before content work.
    // Use its real observer for imported URL-only fixtures, never a manual
    // confirmation or a renderer bridge replacement.
    const sourceInput={productId:current.id,productRevision:sources.product.revision,variantId:current.variants[0].id};
    let sourceView=await window.red.getSourceConsistency(sourceInput);
    if(sourceView.status==='PENDING')sourceView=await window.red.prepareSourceConsistency(sourceInput);
    if(!['MATCH','MANUAL'].includes(sourceView.status))throw Error('Source fixture observation failed: '+sourceView.status);

    const prepared = await window.red.listAmazonDrafts(current.id);
    let draft = prepared.find(value => value.variantId === current.variants[0].id && value.productRevision === sources.product.revision);
    if (!draft) draft = (await window.red.prepareAmazonDrafts({ targetId, productType: 'HTC_DEMO_STORAGE_BAG', parentageLevel: 'NONE', requirements: 'LISTING', locale: 'en_US', listingProgram: 'standard', items: [{ productId: current.id, productRevision: sources.product.revision, variantId: current.variants[0].id, attributes: {} }] })).items[0].draft;
    if (!draft) throw Error('Image test draft missing');
    globalThis.__imageWorkflowPromise = window.red.completeAutomaticProduct({ draftId: draft.id, draftRevision: draft.revision });
    return draft.id;
  }, { product, targetId });
}
async function screenshot(name) {
  await page.evaluate(async () => { await document.fonts.ready; });
  const encoded = await app.evaluate(async ({ BrowserWindow }) => {
    const capture=BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
    let timer;try{return (await Promise.race([capture,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Native screenshot timed out')),10000);})])).toPNG().toString('base64');}finally{clearTimeout(timer);}
  });
  const path = join(artifacts, `${build.packaged ? 'packaged-' : ''}automatic-images-${name}.png`);
  await writeFile(path, Buffer.from(encoded, 'base64')); screenshots.push(path); await assertHidden();
}
function assertPrivate(value) {
  const text = JSON.stringify(value);
  for (const key of Object.values(fakeKeys)) assert.equal(text.includes(key), false, 'Credentials must not reach renderer output or logs');
}

try {
  await launch();
  const target = await page.evaluate(() => window.red.enableAmazonDemo());
  await page.evaluate(async () => { const rules = await window.red.getListingRules(); rules.product.variantLimit = 1; rules.pricing.bundleEnabled = false; await window.red.saveListingRules(rules); });
  const first = await createProduct('PASS');
  await selectProduct(first.product, target.id);
  await expect(panel().locator('details[aria-label="全局自动化连接"]')).toContainText('连接尚未就绪');
  await expect(button('启动并自动发布')).toBeDisabled();
  assert.deepEqual(await app.evaluate(() => globalThis.__automaticImagesE2E.calls), []);
  await configure();
  const passed = await scenario(first, target.id, 'pass', 'done', 1);
  assert.equal(passed.workflow.status, 'COMPLETED'); assert.equal(passed.workflow.attempt, 7);assert.equal(passed.workflow.slots.filter(slot=>slot.status==='PASSED').length,7);
  assert.ok(passed.workflow.approvedAssetId && passed.workflow.approvedSha256);
  const approved = passed.current.assets.find(asset => asset.id === passed.workflow.approvedAssetId);
  assert.equal(approved.role, 'gallery'); assert.deepEqual(approved.variantIds, [passed.product.variants[0].id]);
  assert.equal(sha256(await readFile(join(dataRoot, 'assets', `${approved.id}.png`))), passed.workflow.approvedSha256);
  const results = await page.evaluate(id => window.red.listAiResults(id), passed.product.id);
  assert.ok(results.some(result => result.output.kind === 'listing-current-review' && result.output.verdict === 'PASS'));
  assert.ok(results.some(result => result.output.kind === 'image-text-review' && result.output.verdict === 'PASS' && result.output.visualReview === 'not_performed'));
  assert.deepEqual(passed.calls.map(call => call.kind), ['listing-fields', 'listing-fields-review', 'listing-current-review','source-ocr','image-plan',...Array.from({length:7},(_,index)=>['image-plan', 'image-generation', 'ip-token', 'ip-upload', 'ip-check', 'image-appearance-review', ...(index===0?['ocr', 'image-text-review']:[])]).flat()]);
  assert.equal(passed.calls.filter(call=>call.kind==='ocr').length,1);
  assert.equal(passed.calls.filter(call=>call.kind==='image-text-review').length,1);
  assert.ok(passed.workflow.slots.slice(1).every(slot=>slot.attempts.every(attempt=>!attempt.ocrResultId&&!attempt.reviewResultId)));
  assert.equal(passed.workflow.error, null);
  pass('global setup gates execution; production IPC creates and reviews copy, then generates and checks all seven image slots for the selected SKU');
  const visualPlan = results.find(result => result.output.kind === 'image-plan');
  assert.equal(visualPlan.imageContext.policyVersion, 'product-image/ip-v3');
  assert.equal(visualPlan.output.ipRisk.verdict, 'PASS');
  const ipReview = results.find(result => result.output.kind === 'image-ip-review');
  assert.equal(ipReview.output.verdict, 'PASS'); assert.equal(ipReview.output.candidate.sha256, passed.workflow.approvedSha256);
  assert.equal(passed.workflow.ipReviewResultIds[0],ipReview.id);assert.equal(passed.workflow.ipReviewResultIds.length,7);
  assert.equal(visualPlan.output.productUnderstanding.sufficient, true);
  assert.deepEqual(visualPlan.output.productUnderstanding.referenceAssetIds, passed.workflow.referenceAssets.map(asset => asset.id));
  assert.ok(!JSON.stringify(results).includes('data:image/'));
  pass('DeepSeek receives decodable original SKU images, persists its visual understanding, and hands that understanding plus byte-identical references to GPT');

  const beforeReuse = await app.evaluate(() => globalThis.__automaticImagesE2E.calls.length);
  await beginImageWorkflow(passed.product, target.id); assert.equal((await page.evaluate(() => globalThis.__imageWorkflowPromise)).workflow.status, 'COMPLETED');
  assert.equal(await app.evaluate(() => globalThis.__automaticImagesE2E.calls.length), beforeReuse);
  assert.equal((await page.evaluate(id => window.red.getAutomaticProductProgress(id), passed.draft.id)).id, passed.workflow.id);
  pass('repeating preparation reuses the completed workflow and does not repeat paid provider requests');

  const ftpPath = join(dataRoot, 'ftp-fixture.json');
  await writeFile(ftpPath, JSON.stringify({ id: 'alpha', host: 'ftp.example.test', port: 21, secure: false, username: 'fixture-user', password: 'fixture-password-only', remoteRoot: '/', publicBaseUrl: 'https://images.example.test/automatic/' }));
  await chooseFile(ftpPath); await page.evaluate(() => window.red.importFtpProfile());
  await page.evaluate(() => window.red.setFtpProfileEnabled({ id: 'alpha', enabled: true }));
  const task = await page.evaluate(draftId => window.red.createExecutionTask({ draftIds: [draftId], profileId: 'alpha' }), passed.draft.id);
  assert.equal(task.status, 'CREATED'); assert.equal(task.items[0].assets.find(asset => asset.role === 'main')?.id, approved.id);
  assert.equal(task.items[0].assets.length,7);assert.equal(task.items[0].assets.filter(asset=>asset.role==='gallery').length,6);
  assert.ok(task.items[0].steps.every(step => step.status === 'PENDING'));
  await page.evaluate(id => window.red.cancelExecutionTask(id), task.id);
  pass('normal execution selects one approved main and six approved gallery images without changing source asset roles or submitting');

  if(scope==='all-image-cases'){
  const repaired = await scenario(await createProduct('REPAIR'), target.id, 'repair', 'done', 2);
  assert.equal(repaired.workflow.status, 'COMPLETED'); assert.equal(repaired.workflow.attempt, 8);assert.equal(repaired.workflow.slots[0].attempts.length,2);
  assert.equal(repaired.calls.filter(call => call.kind === 'image-generation').length, 8);
  assert.equal(repaired.calls.filter(call => call.kind === 'listing-current-review').length, 1);
  assert.deepEqual(repaired.calls.filter(call => call.kind === 'image-plan').map(call => call.repair), [false, false, true,...Array(6).fill(false)]);
  pass('known text rejection repairs only the failed slot; UI polls and displays attempt 2 while retaining the seven-slot workflow');

  const blocked = await scenario(await createProduct('BLOCKED'), target.id, 'blocked', 'blocked');
  assert.equal(blocked.workflow.status, 'BLOCKED'); assert.equal(blocked.workflow.attempt, 9); assert.equal(blocked.workflow.approvedAssetId, null);
  assert.equal(blocked.workflow.slots[0].attempts.length,3);assert.equal(blocked.workflow.slots[0].approvedAssetId,null);
  assert.ok(blocked.workflow.slots.slice(1).every(slot=>slot.status==='PASSED'&&slot.attempts.length===1&&slot.approvedAssetId));
  assert.equal(blocked.current.assets.length, blocked.product.assets.length+6);
  assert.equal(blocked.calls.filter(call => call.kind === 'image-generation').length, 9);
  assert.equal(blocked.calls.filter(call=>call.kind==='ocr').length,3);
  assert.equal(blocked.calls.filter(call=>call.kind==='image-text-review').length,3);
  assert.match(blocked.workflow.error, /最多 3 次/);
  pass('the rejected main stops after three attempts while six detail slots pass IP checks once and retain their approved images');

  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await click(button(theme === 'dark' ? '切换到夜间模式' : '切换到日间模式'));
    for (const [width, height] of [[1480, 960], [760, 800]]) {
      await resizeWindow(app, page, width, height); await panel().evaluate(element => element.scrollIntoView({ block: 'center' }));
      const overflow = await page.evaluate(() => [...document.querySelectorAll('.automatic-connections, .automatic-image-progress, .automatic-stage-list, .amazon-workflow')].filter(element => element.clientWidth && element.scrollWidth > element.clientWidth + 2).map(element => element.className));
      assert.deepEqual(overflow, []); layouts.push({ width, height, theme, overflow }); await screenshot(`${theme}-${width}`);
    }
  }
  pass('global prerequisites and stage/attempt results fit wide and narrow windows in both themes');

  const unclear = await scenario(await createProduct('UNCLEAR'), target.id, 'vision-unclear', 'blocked');
  assert.equal(unclear.workflow.stage, 'planning'); assert.equal(unclear.workflow.approvedAssetId, null);
  assert.equal(unclear.calls.filter(call => call.kind === 'image-generation').length, 0);
  assert.equal(unclear.calls.filter(call => call.kind === 'ocr').length, 0);
  assert.equal(unclear.workflow.error, '来源图片不足以确认当前商品。请核对已关联原图和当前规格。');
  const unclearPlan=(await page.evaluate(id=>window.red.listAiResults(id),unclear.product.id)).find(result=>result.output.kind==='image-plan');
  assert.ok(unclearPlan.output.productUnderstanding.uncertainties.includes('来源图片无法确认当前 SKU。'));
  pass('insufficient visual understanding stops at planning and displays the reason before any image generation or OCR request');

  const sourceRisk = await scenario(await createProduct('SOURCE-IP'), target.id, 'ip-source', 'blocked');
  assert.equal(sourceRisk.workflow.stage, 'planning'); assert.equal(sourceRisk.workflow.approvedAssetId, null);
  assert.equal(sourceRisk.calls.filter(call => ['image-generation','ip-token','ocr'].includes(call.kind)).length, 0);
  assert.match(sourceRisk.workflow.error, /来源 AI IP 初筛未通过（非阿里云评分）/); assert.match(sourceRisk.workflow.error, /测试知名角色/);
  pass('a source IP finding stops before image generation and shows its concrete evidence');

  const generatedRisk = await scenario(await createProduct('GENERATED-IP'), target.id, 'ip-generated', 'blocked');
  assert.equal(generatedRisk.workflow.stage, 'ip-check'); assert.equal(generatedRisk.workflow.approvedAssetId, null);
  assert.equal(generatedRisk.calls.filter(call => call.kind === 'image-generation').length, 1);
  assert.equal(generatedRisk.calls.filter(call => call.kind === 'ocr').length, 0); assert.equal(generatedRisk.workflow.ipReviewResultIds.length, 1);
  assert.equal(generatedRisk.current.assets.length, generatedRisk.product.assets.length);
  assert.match(generatedRisk.workflow.error, /实际等级 high/); assert.match(generatedRisk.workflow.error, /当前阈值 分数 > 90 或等级 ≥ high/); assert.match(generatedRisk.workflow.error, /trademark/);
  const generatedRiskResult=(await page.evaluate(id=>window.red.listAiResults(id),generatedRisk.product.id)).find(result=>result.output.kind==='image-ip-review');
  assert.equal(generatedRiskResult.output.verdict,'BLOCKED'); assert.equal(generatedRiskResult.output.labels[0].description,'检测到疑似品牌标识');
  pass('Aliyun checks the exact generated bytes; an IP finding stops before OCR without regeneration or adoption');

  const unavailable = await scenario(await createProduct('IP-UNAVAILABLE'), target.id, 'ip-unavailable', 'failed');
  assert.equal(unavailable.workflow.stage, 'ip-check'); assert.equal(unavailable.workflow.approvedAssetId, null);
  assert.equal(unavailable.calls.filter(call => call.kind === 'image-generation').length, 1);
  assert.equal(unavailable.calls.filter(call => call.kind === 'ip-check').length, 1);
  assert.equal(unavailable.calls.filter(call => call.kind === 'ocr').length, 0);
  assert.match(unavailable.workflow.error, /图片侵权检测未完成/); assert.match(unavailable.workflow.error, /开通状态/);
  pass('unopened moderation service stops with actionable setup information and never counts as PASS');

  await resizeWindow(app,page,1440,1000);
  await click(page.locator('nav').getByRole('button',{name:'设置',exact:true}));
  await click(button('图片与生图'));
  const riskSwitch=page.getByRole('switch',{name:'启用图片风险拦截'});
  await expect(riskSwitch).toBeEnabled();await expect(riskSwitch).toBeChecked();await riskSwitch.click();await expect(riskSwitch).not.toBeChecked();
  await expect.poll(()=>page.evaluate(()=>window.red.getImageRiskSettings())).toEqual({enabled:false,scoreThreshold:90,levelThreshold:'high'});
  await screenshot('risk-interception-disabled');
  const disabledRisk=await scenario(await createProduct('RISK-DISABLED'),target.id,'ip-source','done');
  assert.equal(disabledRisk.workflow.riskInterceptionEnabled,false);
  assert.equal(disabledRisk.calls.filter(call=>['ip-token','ip-upload','ip-check'].includes(call.kind)).length,0);
  assert.equal(disabledRisk.calls.filter(call=>call.kind==='ocr').length,1);
  assert.equal(disabledRisk.workflow.slots.filter(slot=>slot.attempts.at(-1).riskBypass).length,7);
  const oldRiskCandidate=generatedRisk.workflow.slots[0].attempts[0].candidateId;
  const retryBefore=await app.evaluate(()=>globalThis.__automaticImagesE2E.calls.length);
  const recoveredRisk=await page.evaluate(async input=>{const draft=(await window.red.listAmazonDrafts(input.productId)).find(draft=>draft.id===input.draftId);return window.red.completeAutomaticProduct({draftId:draft.id,draftRevision:draft.revision});},{productId:generatedRisk.product.id,draftId:generatedRisk.draft.id});
  assert.equal(recoveredRisk.workflow.status,'COMPLETED',recoveredRisk.workflow.error??'');
  assert.equal(recoveredRisk.workflow.slots[0].attempts[0].candidateId,oldRiskCandidate);
  const recoveredCalls=await app.evaluate((_electron,before)=>globalThis.__automaticImagesE2E.calls.slice(before),retryBefore);
  assert.equal(recoveredCalls.filter(call=>call.kind==='image-generation').length,6);
  assert.equal(recoveredCalls.filter(call=>call.kind==='ip-check').length,0);
  await page.evaluate(()=>window.red.saveImageRiskSettings({enabled:true}));
  const restoreBefore=await app.evaluate(()=>globalThis.__automaticImagesE2E.calls.length);
  const restoredRisk=await page.evaluate(async input=>{const draft=(await window.red.listAmazonDrafts(input.productId)).find(draft=>draft.id===input.draftId);return window.red.completeAutomaticProduct({draftId:draft.id,draftRevision:draft.revision});},{productId:disabledRisk.product.id,draftId:disabledRisk.draft.id});
  assert.equal(restoredRisk.workflow.status,'BLOCKED');assert.match(restoredRisk.workflow.error,/IP 初筛/);
  assert.equal((await app.evaluate((_electron,before)=>globalThis.__automaticImagesE2E.calls.slice(before),restoreBefore)).filter(call=>call.kind==='image-generation').length,0);
  pass('risk switch persists through real UI/IPC, skips risk providers while retaining main OCR, resumes an existing blocked candidate, and reenabling never treats skipped checks as PASS');

  await click(page.locator('nav').getByRole('button',{name:'设置',exact:true}));
  await click(button('图片与生图'));
  const copySwitch=page.getByRole('switch',{name:'启用文案复核',exact:true});
  await expect(copySwitch).toBeEnabled();await expect(copySwitch).toBeChecked();await copySwitch.click();await expect(copySwitch).not.toBeChecked();
  await expect.poll(()=>page.evaluate(()=>window.red.getCopyReviewSettings())).toEqual({enabled:false});
  await expect(riskSwitch).toBeChecked();
  await screenshot('copy-review-disabled');
  const disabledCopy=await scenario(await createProduct('COPY-DISABLED'),target.id,'pass','done');
  assert.equal(disabledCopy.workflow.copyReviewEnabled,false);
  assert.equal(disabledCopy.workflow.imageContext.listingReviewResultId,null);
  assert.equal(disabledCopy.workflow.imageContext.copyReviewBypass.policy,'copy-review-disabled/v1');
  assert.ok(disabledCopy.calls.some(call=>call.kind==='listing-fields'),'Necessary copy fields must still be generated');
  assert.equal(disabledCopy.calls.filter(call=>['listing-fields-review','listing-current-review'].includes(call.kind)).length,0);
  assert.equal(disabledCopy.calls.filter(call=>call.kind==='image-generation').length,7);
  assert.equal(disabledCopy.calls.filter(call=>call.kind==='ip-check').length,7,'The independent risk switch remains enabled');
  assert.equal(disabledCopy.calls.filter(call=>call.kind==='ocr').length,1);
  assert.equal(disabledCopy.calls.filter(call=>call.kind==='image-text-review').length,1);
  assert.ok(disabledCopy.draft.fieldAdoptions.some(adoption=>adoption.reviewDisposition==='SKIPPED_DISABLED'&&adoption.reviewResultId===null));
  assert.ok(disabledCopy.draft.attributes.color?.length,'Required generated fields must still be adopted');
  const skippedCopyResults=await page.evaluate(id=>window.red.listAiResults(id),disabledCopy.product.id);
  assert.ok(skippedCopyResults.every(result=>!['amazon-fields-review','listing-current-review'].includes(result.output.kind)),'No skipped review may be persisted as PASS');
  const skippedCopyPlan=skippedCopyResults.find(result=>result.output.kind==='image-plan');
  assert.equal(skippedCopyPlan.imageContext.copyReviewBypass.policy,'copy-review-disabled/v1');
  await expect(panel().locator('details[aria-label="全局自动化连接"]')).toContainText('文案复核：已关闭');
  pass('copy review switch saves through real UI/IPC, still generates required fields and skips both copy review calls while retaining independent risk and main no-text checks');

  await click(page.locator('nav').getByRole('button',{name:'设置',exact:true}));
  await click(button('图片与生图'));
  await expect(copySwitch).not.toBeChecked();await copySwitch.click();await expect(copySwitch).toBeChecked();
  await expect.poll(()=>page.evaluate(()=>window.red.getCopyReviewSettings())).toEqual({enabled:true});
  const copyRecheckBefore=await app.evaluate(()=>globalThis.__automaticImagesE2E.calls.length);
  const recheckedCopy=await page.evaluate(async input=>{const draft=(await window.red.listAmazonDrafts(input.productId)).find(value=>value.id===input.draftId);return window.red.completeAutomaticProduct({draftId:draft.id,draftRevision:draft.revision});},{productId:disabledCopy.product.id,draftId:disabledCopy.draft.id});
  assert.equal(recheckedCopy.workflow.status,'COMPLETED',recheckedCopy.workflow.error??'');
  assert.equal(recheckedCopy.workflow.recheckedFromRunId,disabledCopy.workflow.id);
  assert.notEqual(recheckedCopy.workflow.copyReviewEnabled,false);
  assert.equal(recheckedCopy.workflow.imageContext.copyReviewBypass,undefined);
  assert.ok(recheckedCopy.workflow.imageContext.listingReviewResultId);
  assert.deepEqual(recheckedCopy.workflow.slots.map(slot=>slot.approvedAssetId),disabledCopy.workflow.slots.map(slot=>slot.approvedAssetId));
  assert.deepEqual(recheckedCopy.workflow.slots.map(slot=>slot.approvedSha256),disabledCopy.workflow.slots.map(slot=>slot.approvedSha256));
  const copyRecheckCalls=await app.evaluate((_electron,before)=>globalThis.__automaticImagesE2E.calls.slice(before),copyRecheckBefore);
  assert.equal(copyRecheckCalls.filter(call=>call.kind==='image-generation').length,0);
  assert.equal(copyRecheckCalls.filter(call=>call.kind==='listing-current-review').length,1);
  assert.equal(copyRecheckCalls.filter(call=>call.kind==='ocr').length,1);
  assert.equal(copyRecheckCalls.filter(call=>call.kind==='image-text-review').length,1);
  const recheckedCopyResults=await page.evaluate(id=>window.red.listAiResults(id),disabledCopy.product.id);
  assert.deepEqual(recheckedCopyResults.find(result=>result.id===skippedCopyPlan.id),skippedCopyPlan,'Rechecking must preserve the old explicit skip evidence');
  runs.push({mode:'copy-review-reenabled',productId:disabledCopy.product.id,draftId:disabledCopy.draft.id,workflow:recheckedCopy.workflow,calls:copyRecheckCalls});
  pass('reenabling copy review checks the existing seven-image set with real copy review, zero regeneration and unchanged managed images, while retaining prior skip history');

  const cancelled = await scenario(await createProduct('CANCEL'), target.id, 'cancel', 'stopped', 1);
  assert.equal(cancelled.workflow.status, 'CANCELLED'); assert.equal(cancelled.workflow.approvedAssetId, null);
  assert.equal(cancelled.calls.filter(call => call.kind === 'image-generation').length, 1);
  assert.ok(cancelled.calls.find(call => call.kind === 'image-generation').aborted);
  const failed = await scenario(await createProduct('FAILED'), target.id, 'network-error', 'failed');
  assert.equal(failed.workflow.status, 'FAILED'); assert.equal(failed.workflow.approvedAssetId, null);
  assert.equal(failed.calls.filter(call => call.kind === 'image-generation').length, 1);
  assert.equal(failed.calls.filter(call => call.kind === 'ocr').length, 0);
  pass('pause cancels the in-flight automatic request; an ambiguous generation failure is never automatically retried or adopted');

  // Enter through the same automatic UI with only the original imported image
  // URLs. No downloadMiaoshouImages / importImages call or manual image binding
  // prepares this product. Missing factual copy remains a real blocked result.
  const remote = await importRemoteProduct(), remoteVariant = remote.product.variants[0];
  await selectProduct(remote.product, target.id);
  await app.evaluate(() => { const state = globalThis.__automaticImagesE2E; state.mode = 'source-only'; state.imageCount = 0; state.holdAttempt = 0; });
  const beforeRemote = await app.evaluate(() => globalThis.__automaticImagesE2E.calls.length);
  await beginImageWorkflow(remote.product, target.id);
  assert.equal((await page.evaluate(() => globalThis.__imageWorkflowPromise)).workflow.status, 'BLOCKED');
  const downloaded = await page.evaluate(id => window.red.getProduct(id), remote.product.id);
  const remoteDrafts = await page.evaluate(id => window.red.listAmazonDrafts(id), remote.product.id);
  assert.equal(remoteDrafts.length, 1); assert.equal(remoteDrafts[0].productRevision, downloaded.revision);
  assert.ok(downloaded.revision > remote.product.revision, 'The first automatic run must use the downloaded product revision');
  assert.equal(downloaded.assets.length, 1, 'Download only one successful mapped reference for the selected SKU');
  assert.ok(downloaded.assets[0].variantIds.includes(remoteVariant.id));
  const sourceImageIds = remote.receipt.skuMappings.find(mapping => mapping.localVariantId === remoteVariant.id).imageIds;
  const receiptBindings = remote.receipt.skuMappings.filter(mapping => mapping.imageIds.some(id => sourceImageIds.includes(id))).map(mapping => mapping.localVariantId).sort();
  assert.ok(receiptBindings.includes(remoteVariant.id)); assert.ok(receiptBindings.length>1,'Fixture must preserve sibling SKU mapping evidence');
  assert.deepEqual([...downloaded.assets[0].variantIds], [remoteVariant.id], 'Automatic source preparation binds only the requested SKU');
  assert.deepEqual((await page.evaluate(id=>window.red.getMiaoshouReceipt(id),remote.product.id)).skuMappings,remote.receipt.skuMappings,'Preparing one SKU never removes sibling source mappings');
  const downloadedBytes = await readFile(join(dataRoot, 'assets', `${downloaded.assets[0].id}.png`));
  assert.equal(downloadedBytes.length, downloaded.assets[0].byteSize);
  assert.ok(downloadedBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  const remoteWorkflow = await page.evaluate(id => window.red.getAutomaticProductProgress(id), remoteDrafts[0].id);
  const remoteCalls = await app.evaluate((_electron, before) => globalThis.__automaticImagesE2E.calls.slice(before), beforeRemote);
  assert.equal(remoteWorkflow.status, 'BLOCKED'); assert.equal(remoteWorkflow.stage, 'content'); assert.equal(remoteWorkflow.approvedAssetId, null);
  assert.ok(remoteCalls.every(call => !['image-generation','listing-current-review'].includes(call.kind)));
  assert.match(remoteWorkflow.error, /商品字段尚未修复完成/);
  assert.ok(remoteWorkflow.contentPreparation.remaining.some(message=>message.includes('brand')));
  runs.push({ mode: 'miaoshou-source-only', productId: remote.product.id, initialRevision: remote.product.revision, sourceUrls: remote.receipt.snapshot.images.map(image => image.url),
    downloadedRevision: downloaded.revision, downloadedSha256: sha256(downloadedBytes), assets: downloaded.assets, draftId: remoteDrafts[0].id, workflow: remoteWorkflow, calls: remoteCalls });
  await panel().evaluate(element => element.scrollIntoView({ block: 'center' })); await screenshot('miaoshou-source');
  pass('an untouched Miaoshou URL import downloads its mapped reference and creates a draft at the new revision; missing business fields stop before copy review and generation');

  const beforeRemoteRepeat = await app.evaluate(() => globalThis.__automaticImagesE2E.calls.length);
  await expect(panel().getByTestId(`automatic-select-${remote.product.id}`)).toBeChecked();
  await beginImageWorkflow(remote.product, target.id);
  assert.equal((await page.evaluate(() => globalThis.__imageWorkflowPromise)).workflow.status, 'BLOCKED');
  const repeatedDrafts = await page.evaluate(id => window.red.listAmazonDrafts(id), remote.product.id);
  const repeatedProduct = await page.evaluate(id => window.red.getProduct(id), remote.product.id);
  assert.equal(repeatedDrafts.length, 1); assert.equal(repeatedDrafts[0].id, remoteDrafts[0].id); assert.equal(repeatedProduct.revision, downloaded.revision);
  assert.deepEqual(repeatedProduct.assets, downloaded.assets);
  assert.deepEqual(await app.evaluate((_electron, before) => globalThis.__automaticImagesE2E.calls.slice(before), beforeRemoteRepeat),[],'unchanged incomplete fields reuse their saved result instead of repeating paid requests');
  assert.equal(repeatedDrafts[0].id, remoteDrafts[0].id);
  pass('restarting directly in the same UI preserves selection, uses refreshed product details and reuses downloaded sources without a stale revision or duplicate draft');

  // Satisfy only commercial prerequisites to exercise unsupported-copy review separately.
  // These isolated test inputs do not create source facts for the imported description.
  await page.evaluate(async ({draftId,productId})=>{
    const draft=(await window.red.listAmazonDrafts(productId)).find(value=>value.id===draftId);
    await window.red.saveAmazonDraft({id:draft.id,revision:draft.revision,attributes:{...draft.attributes,
      brand:[{value:'Generic',marketplace_id:'ATVPDKIKX0DER'}],
      purchasable_offer:[{marketplace_id:'ATVPDKIKX0DER',currency:'USD',audience:'ALL',our_price:[{schedule:[{value_with_tax:2.5}]}]}]}});
  },{draftId:remoteDrafts[0].id,productId:remote.product.id});
  const beforeCopyBlock=await app.evaluate(()=>globalThis.__automaticImagesE2E.calls.length);
  const priorCopyCallIds=await page.evaluate(async()=> (await window.red.listAiCalls()).map(call=>call.id));
  await beginImageWorkflow(remote.product,target.id);
  const copyBlocked=(await page.evaluate(()=>globalThis.__imageWorkflowPromise)).workflow;
  assert.equal(copyBlocked.status,'BLOCKED');assert.match(copyBlocked.error,/商品文案复核未通过/);
  const copyBlockCalls=await app.evaluate((_electron,before)=>globalThis.__automaticImagesE2E.calls.slice(before),beforeCopyBlock);
  assert.equal(copyBlockCalls.filter(call=>call.kind==='listing-current-review').length,2,'Unsupported copy receives the configured first and difficult reviews exactly once');
  const copyCalls=await page.evaluate(ids=>window.red.listAiCalls().then(calls=>calls.filter(call=>!ids.includes(call.id))),priorCopyCallIds);
  assert.deepEqual(copyCalls.map(call=>call.purposeSnapshot.purposeId).sort(),['copy_review','copy_review_difficult']);
  assert.ok(copyBlockCalls.every(call=>call.kind!=='image-generation'));
  const beforeCopyRepeat=await app.evaluate(()=>globalThis.__automaticImagesE2E.calls.length);
  await beginImageWorkflow(remote.product,target.id);
  assert.equal((await page.evaluate(()=>globalThis.__imageWorkflowPromise)).workflow.status,'BLOCKED');
  assert.equal(await app.evaluate(()=>globalThis.__automaticImagesE2E.calls.length),beforeCopyRepeat);
  pass('with required business fields supplied, unsupported imported copy is blocked and its configured difficult review is recorded and both saved rejections prevent repeated paid reviews');

  assert.equal((await page.evaluate(() => window.red.listAmazonCalls())).filter(call => call.operation === 'putListingsItem').length, 0);
  assertPrivate(await page.evaluate(() => ({ text: document.body.innerText, localStorage: { ...localStorage }, sessionStorage: { ...sessionStorage } })));
  await page.evaluate(()=>window.red.saveImageRiskSettings({enabled:false}));
  await page.evaluate(()=>window.red.saveCopyReviewSettings({enabled:false}));
  await close(); await launch();
  assert.deepEqual(await page.evaluate(()=>window.red.getImageRiskSettings()),{enabled:false,scoreThreshold:90,levelThreshold:'high'});
  assert.deepEqual(await page.evaluate(()=>window.red.getCopyReviewSettings()),{enabled:false});
  assert.equal((await page.evaluate(id=>window.red.getAutomaticProductProgress(id),disabledCopy.draft.id)).id,recheckedCopy.workflow.id);
  assert.deepEqual((await page.evaluate(id=>window.red.listAiResults(id),disabledCopy.product.id)).find(result=>result.id===skippedCopyPlan.id),skippedCopyPlan);
  assert.equal((await page.evaluate(id => window.red.getAutomaticProductProgress(id), passed.draft.id)).approvedAssetId, approved.id);
  assert.equal((await page.evaluate(id => window.red.getAutomaticProductProgress(id), blocked.draft.id)).status, 'BLOCKED');
  assert.equal((await page.evaluate(id => window.red.getProduct(id), passed.product.id)).assets.find(asset => asset.id === approved.id).role, 'gallery');
  assert.deepEqual(await app.evaluate(() => globalThis.__automaticImagesE2E.calls), []);
  pass('restart retains both independent switches, completed/blocked workflow records and explicit copy-skip history without replaying provider requests');

  const backupPath = join(artifacts, `${build.packaged ? 'packaged-' : ''}automatic-images-${startedAt.replace(/[:.]/g, '-')}.htcbackup`);
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, backupPath);
  const backup = await page.evaluate(() => window.red.createWorkspaceBackup({ passphrase: 'automatic-images-isolated-backup-2026' }));
  assert.equal(backup.cancelled, false); assert.equal(backup.productCount, 12);
  const backupBytes = await readFile(backupPath);
  assert.equal(backupBytes.subarray(0,13).toString(),'HTC-BACKUP-2\n');
  const inspectRoot=await mkdtemp(resolve('.test-data/automatic-images-backup-inspection-'));
  const manifest=await readStreamingBackup(backupPath,'automatic-images-isolated-backup-2026',inspectRoot,path=>join(inspectRoot,path));
  const assetPaths=manifest.files.map(file=>file.path);
  assert.ok(assetPaths.includes(`assets/${approved.id}.png`));
  assert.ok(assetPaths.every(path=>path==='red.sqlite'||path.startsWith('assets/')||path.startsWith('documents/')||path.startsWith('ai-receipts/')||/^image-generation\/candidates\/[a-f0-9-]{36}\/(candidate\.json|image\.png|preview\.png)$/.test(path)));
  assert.equal(assetPaths.some(path=>/vault|browser/i.test(path)),false,'Credentials and browser data never enter the encrypted backup');
  assert.ok(assetPaths.some(path=>path.startsWith('ai-receipts/')),'Paid provider receipts remain recoverable');
  for(const id of passed.workflow.candidateIds){
    for(const file of ['candidate.json','image.png','preview.png']){
      const relative=`image-generation/candidates/${id}/${file}`;
      assert.ok(assetPaths.includes(relative),'Paid candidates are retained history in v2 backups');
      assert.deepEqual(await readFile(join(inspectRoot,relative)),await readFile(join(dataRoot,relative)));
    }
  }
  for(const file of manifest.files){
    const bytes=await readFile(join(inspectRoot,file.path));
    assert.equal(sha256(bytes),file.sha256);
    for(const key of Object.values(fakeKeys))assert.equal(bytes.includes(Buffer.from(key)),false);
  }
  backups.push({ ...backup, sha256: sha256(backupBytes), assetPaths });
  const afterBackup = await page.evaluate(() => window.red.createProduct());
  await chooseFile(backupPath);
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await assertHidden();
  // V2 authenticates hundreds of retained candidate/receipt files before exit.
  // Attach rejection immediately so a close timeout cannot become an unhandled
  // rejection while the restore IPC is still running.
  const closedForRestore = app.waitForEvent('close', { timeout: 180000 }).then(() => null, error => error);
  const restored = await page.evaluate(() => window.red.restoreWorkspaceBackup({ passphrase: 'automatic-images-isolated-backup-2026' }));
  assert.equal(restored.cancelled, false);
  sessions.push(await app.evaluate(() => { const { calls, unexpected, remoteRequests, shownWindows } = globalThis.__automaticImagesE2E; return { calls, unexpected, remoteRequests, shownWindows }; }));
  const restoreCloseError = await closedForRestore; if (restoreCloseError) throw restoreCloseError; app = null; page = null;
  await launch();
  const restoredProducts = await page.evaluate(() => window.red.listProducts());
  assert.equal(restoredProducts.length, 12); assert.ok(!restoredProducts.some(product => product.id === afterBackup.id));
  assert.deepEqual(await page.evaluate(()=>window.red.getImageRiskSettings()),{enabled:false,scoreThreshold:90,levelThreshold:'high'});
  assert.deepEqual(await page.evaluate(()=>window.red.getCopyReviewSettings()),{enabled:false});
  assert.equal((await page.evaluate(id=>window.red.getAutomaticProductProgress(id),disabledCopy.draft.id)).id,recheckedCopy.workflow.id);
  assert.deepEqual((await page.evaluate(id=>window.red.listAiResults(id),disabledCopy.product.id)).find(result=>result.id===skippedCopyPlan.id),skippedCopyPlan);
  assert.equal((await page.evaluate(id => window.red.getAutomaticProductProgress(id), passed.draft.id)).approvedAssetId, approved.id);
  assert.equal((await page.evaluate(id => window.red.getAutomaticProductProgress(id), blocked.draft.id)).status, 'BLOCKED');
  assert.equal(sha256(await readFile(join(dataRoot, 'assets', `${approved.id}.png`))), passed.workflow.approvedSha256);
  assert.equal((await page.evaluate(id => window.red.listAiResults(id), passed.product.id)).length, results.length);
  assert.ok((await page.evaluate(() => window.red.listAiProviders())).every(profile => !profile.configured && !profile.enabled));
  assert.equal((await page.evaluate(() => window.red.getImageGenerationConnection('openrouter'))).configured, false);
  await selectProduct(passed.product, target.id);
  await expect(panel().locator('details[aria-label="全局自动化连接"]')).toContainText('连接尚未就绪');
  await expect(button('启动并自动发布')).toBeDisabled();
  assert.deepEqual(await app.evaluate(() => globalThis.__automaticImagesE2E.calls), []);
  pass('encrypted backup/restore preserves both switches, explicit copy-skip history, approved PNGs and review/workflow provenance, retains paid candidates/receipts and excludes credentials, and returns the UI to setup-required state');
  }
  await close();
  assert.deepEqual(sessions.flatMap(session => session.unexpected), []); assert.deepEqual(sessions.flatMap(session => session.remoteRequests), []);
  assert.deepEqual(sessions.flatMap(session => session.shownWindows), []); assert.deepEqual(errors, []); assertPrivate(processLog); assertPrivate(sessions);
  pass('zero real HTTP(S), visible windows, listing submissions, renderer errors or credential leaks across all sessions');
  succeeded = true;
} catch (error) {
  failure = error.stack || String(error); console.error(failure);
  if (page && !page.isClosed()) {
    await screenshot('failure').catch(() => {});
    const diagnostics = await page.evaluate(async () => ({ text: document.body.innerText, drafts: await Promise.all((await window.red.listProducts()).map(async product => {
      const drafts = await window.red.listAmazonDrafts(product.id); return { productId: product.id, drafts, workflows: await Promise.all(drafts.map(draft => window.red.getAutomaticProductProgress(draft.id))) };
    })) })).catch(() => null);
    if (diagnostics) runs.push({ failureDiagnostics: diagnostics });
  }
} finally {
  await close().catch(error => { errors.push(`cleanup: ${error.message}`); succeeded = false; });
  const report = { passed: succeeded, scope, startedAt, finishedAt: new Date().toISOString(), dataRoot, build, checks, runs, layouts, backups, screenshots, sessions, errors, failure, processLog,
    environment: 'separate hidden production Electron; real preload/IPC/services/safeStorage; isolated data; fake keys; all provider transports mocked before initialization; renderer HTTP(S) blocked; no window.red mocks' };
  let serialized = JSON.stringify(report, null, 2);
  for (const key of Object.values(fakeKeys)) serialized = serialized.replaceAll(key, '[REDACTED FAKE KEY]');
  const path = join(artifacts, `${build.packaged ? 'packaged-' : ''}automatic-images-e2e-report.json`);
  await writeFile(path, `${serialized}\n`); console.log(`REPORT ${path}`);
  if (!succeeded) process.exitCode = 1;
}
