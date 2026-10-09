// Isolated integration harness; never imported by the shipped entry point.
import { app, BrowserWindow, nativeImage, safeStorage } from 'electron';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { WorkspaceStore } from '../../src/main/store.ts';
import { AmazonService } from '../../src/main/amazon/service.ts';
import { HostingService } from '../../src/main/hosting/service.ts';
import { ExecutionService } from '../../src/main/execution/service.ts';
import { AiService } from '../../src/main/ai/service.ts';
import { ImageVersionService } from '../../src/main/image-versions/service.ts';
import { decodeArtifact } from '../../src/main/image-versions/decoder.ts';
import { ReviewedContentService } from '../../src/main/content/service.ts';
import { installIpc } from '../../src/main/ipc.ts';
import { inspectRaster } from '../../src/main/image-format.ts';
import { createLocalFtpServer } from '../helpers/ftp-server.ts';

const root = resolve(process.env.RED_DATA_DIR!); app.setPath('userData', root); app.enableSandbox();
void app.whenReady().then(async () => {
  const ftp = await createLocalFtpServer(), store = new WorkspaceStore(root);
  const amazon = new AmazonService(root, id => store.getProduct(id), safeStorage, { fetch: async () => { throw Error('Amazon network forbidden in AI harness'); } });
  const hosting = new HostingService(root, store, safeStorage, { probe: async expected => {
    const path = new URL(expected.url).pathname.replace(/^\/AAA/, ''), bytes = ftp.files.get(path);
    if (!bytes || bytes.length !== expected.byteSize || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) throw Error('Fixture hosted image mismatch');
  } });
  const requests: { provider: string; model?: string; prompt?: string }[] = [];
  let mode: 'normal' | 'auth-error' | 'hold' | 'review-blocked' | 'opaque-image' | 'truncated-image' | 'bad-crc-image' = 'normal';
  let cutoutSize = { width: 256, height: 256 }, downloads = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const ai = new AiService(root, store, hosting, safeStorage, { timeoutMs: 15000, fetch: async (input, init) => {
    const url = new URL(String(input));
    if (init?.method !== 'POST' || init.redirect !== 'error') throw Error('Provider method/redirect contract');
    const headers = new Headers(init.headers);
    if (url.hostname === 'ocr-api.cn-hangzhou.aliyuncs.com') {
      requests.push({ provider: 'ocr' });
      if (url.searchParams.get('Type') !== 'Commerce' || headers.get('x-acs-action') !== 'RecognizeAllText') throw Error('OCR contract');
      const bytes = Buffer.from(await new Response(init.body).arrayBuffer()), raster = inspectRaster(bytes);
      return json({ RequestId: '11111111-1111-4111-8111-111111111111', Data: { Width: raster.width, Height: raster.height, Content: '棉 收纳袋', SubImageCount: 1,
        SubImages: [{ SubImageId: 0, BlockInfo: { BlockCount: 1, BlockDetails: [{ BlockId: 0, BlockContent: '棉 收纳袋', BlockConfidence: 98 }] } }] } });
    }
    if (url.hostname === 'aidge.cn-beijing.aliyuncs.com') {
      requests.push({ provider: 'segmentation' });
      if (url.searchParams.get('BackGroundType') !== 'TRANSPARENT' || headers.get('x-acs-action') !== 'ImageMatting' || url.searchParams.has('TargetWidth')) throw Error('Aidge migration contract');
      const upload = hosting.listUploads().find(row => row.publicUrl === url.searchParams.get('ImageUrl'));
      if (!upload || upload.status !== 'AVAILABLE') throw Error('Aidge requires verified managed image');
      const asset = store.getAssetRecord(upload.assetId)!;
      cutoutSize = { width: asset.width, height: asset.height };
      return json({ RequestId: '22222222-2222-4222-8222-222222222222', Success: true, Code: 'success', Data: {
        ImageUrl: 'https://fixture.oss-cn-beijing.aliyuncs.com/cutout.png?Expires=9999999999&Signature=fixture-artifact-only',
        Width: asset.width, Height: asset.height, Score: 0.95, UsageMap: { ProcessedImageCount: 1 } } });
    }
    if (url.href === 'https://api.deepseek.com/chat/completions') {
      const body = JSON.parse(String(init.body)), payload = JSON.parse(body.messages[1].content);
      requests.push({ provider: payload.candidate ? 'deepseek-review' : 'deepseek', model: body.model, prompt: JSON.stringify(body.messages) });
      if (body.response_format?.type !== 'json_object' || body.thinking?.type !== 'disabled' || body.stream !== false) throw Error('DeepSeek JSON contract');
      if (mode === 'auth-error') return json({ error: { message: 'SENTINEL_SECRET_DO_NOT_ECHO' } }, 401);
      if (mode === 'hold') return new Promise<Response>((_resolve, reject) => {
        if (init.signal?.aborted) reject(new Error('SENTINEL_SECRET_DO_NOT_ECHO'));
        else init.signal?.addEventListener('abort', () => reject(new Error('SENTINEL_SECRET_DO_NOT_ECHO')), { once: true });
      });
      if (payload.candidate) {
        const fields = ['title', ...payload.candidate.bullets.map((_: string, i: number) => `bullets.${i}`), 'description', ...payload.candidate.attributes.map((_: unknown, i: number) => `attributes.${i}`)];
        const blocked = mode === 'review-blocked';
        return json({ id: 'review-fixture', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ suggestionId: payload.suggestionId, suggestionSha256: payload.suggestionSha256, policyVersion: payload.policyVersion, verdict: blocked ? 'NEEDS_CHANGES' : 'PASS',
          checks: fields.map(field => ({ field, verdict: blocked && field === 'title' ? 'UNSUPPORTED' : 'SUPPORTED', evidenceIds: blocked && field === 'title' ? [] : field.startsWith('attributes.') ? payload.candidate.attributes[Number(field.split('.')[1])].factIds : [payload.confirmedFacts[0]?.id ?? payload.variant.id], reason: 'Checked fixture evidence' })),
          issues: blocked ? [{ code: 'UNSUPPORTED_CLAIM', field: 'title', message: 'Title needs evidence' }] : [] }) } }], usage: { prompt_tokens: 250, completion_tokens: 100 } });
      }
      return json({ id: 'chatcmpl-fixture', model: body.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        title: 'Cotton Storage Bag', bullets: ['Cotton material', 'Blue color', 'For organizing items', 'Source specifications retained', 'Review before publication'], description: 'Cotton storage bag.', attributes: [] }) } }],
        usage: { prompt_tokens: 123, completion_tokens: 42 } });
    }
    throw Error('All other network requests are forbidden in this harness');
  } });
  const images = new ImageVersionService(root, store, ai, { decode: decodeArtifact, download: async url => {
    if (!url.startsWith('https://fixture.oss-cn-beijing.aliyuncs.com/cutout.png?')) throw Error('Unexpected artifact URL'); downloads++;
    const { width, height } = cutoutSize, bitmap = Buffer.alloc(width * height * 4);
    if (mode === 'opaque-image') for (let i = 3; i < bitmap.length; i += 4) bitmap[i] = 255;
    for (let y = Math.floor(height / 4); y < Math.floor(height * 3 / 4); y++) for (let x = Math.floor(width / 4); x < Math.floor(width * 3 / 4); x++) { const i = (y * width + x) * 4; bitmap[i] = 130; bitmap[i + 1] = 70; bitmap[i + 2] = 20; bitmap[i + 3] = 255; }
    const png = nativeImage.createFromBitmap(bitmap, { width, height }).toPNG();
    if (mode === 'truncated-image') return png.subarray(0, png.length - 12);
    if (mode === 'bad-crc-image') {
      for (let at = 8; at + 12 <= png.length;) {
        const length = png.readUInt32BE(at);
        if (png.toString('ascii', at + 4, at + 8) === 'IDAT') { png[at + 8 + length] ^= 1; break; }
        at += length + 12;
      }
    }
    return png;
  } });
  const content = new ReviewedContentService(root, store, ai);
  const execution = new ExecutionService(root, store, amazon, hosting);
  for (const id of ['aliyun-ocr', 'aidge-segmentation', 'deepseek', 'deepseek-review']) writeFileSync(join(root, `${id}.json`), JSON.stringify(id.startsWith('deepseek')
    ? { id, model: id === 'deepseek-review' ? 'deepseek-v4-pro' : 'deepseek-flash', apiKey: 'fixture-api-key-never-public' }
    : { id, accessKeyId: 'fixture-access-key-id', accessKeySecret: 'fixture-access-key-secret', securityToken: '' }));
  writeFileSync(join(root, 'ftp.json'), JSON.stringify({ id: 'alpha', host: ftp.host, port: ftp.port, secure: false, username: 'fixture-user', password: 'fixture-password', remoteRoot: '/', publicBaseUrl: 'https://images.example.com/AAA/' }));
  Object.assign(globalThis, { __aiHarness: {
    snapshot: () => ({ requests, downloads, stor: ftp.commands.filter(command => command === 'STOR').length }),
    mode: (value: typeof mode) => { mode = value; },
    upload: (assetId: string) => hosting.upload({ assetId, profileId: 'alpha', generation: hosting.getProfile('alpha').generation, batchId: '33333333-3333-4333-8333-333333333333' }),
  } });
  const url = 'data:text/html;charset=utf-8,<html><head><meta http-equiv="Content-Security-Policy" content="default-src %27none%27"></head><body>Isolated HTC AI test</body></html>';
  const window = new BrowserWindow({ show: false, webPreferences: { preload: resolve('dist-electron/preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  installIpc(window, store, root, url, amazon, hosting, execution, ai, images, content, async () => { throw Error('Restore covered by dedicated backup tests'); });
  let closed = false, stopping = false;
  app.on('will-quit', event => {
    if (closed) return; event.preventDefault(); if (stopping) return; stopping = true;
    void (async () => { await images.close(); content.close(); await ai.close(); await execution.close(); await hosting.close(); amazon.close(); store.close(); await ftp.close(); closed = true; setImmediate(() => app.quit()); })().catch(() => app.exit(1));
  });
  await window.loadURL(url);
});
