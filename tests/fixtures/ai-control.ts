import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { WorkspaceStore } from '../../src/main/store.ts';
import { importImageFiles } from '../../src/main/assets.ts';
import { HostingService } from '../../src/main/hosting/service.ts';
import { AiService } from '../../src/main/ai/service.ts';
import type { AiDependencies } from '../../src/main/ai/service.ts';
import { AiError } from '../../src/main/ai/errors.ts';
import type { SecretStorage } from '../../src/main/amazon/vault.ts';
import type { AiProviderId } from '../../src/shared/ai-contracts.ts';

const key = randomBytes(32);
export const storage: SecretStorage = {
  isEncryptionAvailable: () => true,
  encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv), data = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); },
  decryptString(value) { const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString(); },
};
export const isCode = (code: string) => (e: unknown) => e instanceof AiError && e.code === code;
export const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
export function responseFor(url: string, options?: RequestInit): Response {
  if (url.includes('ocr-api.')) return json({ RequestId: 'fixture-ocr', Data: { Width: 256, Height: 256, Content: 'Cotton', SubImageCount: 1, SubImages: [{ SubImageId: 0, BlockInfo: { BlockCount: 1, BlockDetails: [{ BlockId: 0, BlockContent: 'Cotton', BlockConfidence: 99 }] } }] } });
  if (url.includes('aidge.')) return json({ Success: true, Code: 'success', RequestId: 'fixture-aidge', Data: { Width: 256, Height: 256, ImageUrl: 'https://output.oss-cn-beijing.aliyuncs.com/cutout.png', UsageMap: { ProcessedImageCount: 1 } } });
  const body = JSON.parse(String(options?.body)), payload = JSON.parse(body.messages[1].content);
  const content = payload.candidate ? { suggestionId: payload.suggestionId, suggestionSha256: payload.suggestionSha256, policyVersion: payload.policyVersion, verdict: 'PASS', checks: ['title', 'bullets.0', 'description'].map(field => ({ field, verdict: 'SUPPORTED', evidenceIds: [payload.confirmedFacts[0].id], reason: 'Confirmed material.' })), issues: [] } : { title: 'Cotton cloth', bullets: ['Cotton material'], description: 'Cotton cloth.', attributes: [] };
  return json({ id: 'fixture-chat', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 23, completion_tokens: 17, total_tokens: 40 } });
}
export function holdFetch() {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  return { started, release, fetch: (async (url, options) => { entered(); await held; return responseFor(String(url), options); }) as typeof fetch };
}
export async function fixture(t: TestContext, dependencies: AiDependencies = {}) {
  await mkdir(resolve('.test-data'), { recursive: true });
  const directory = await mkdtemp(resolve('.test-data/ai-control-')), store = new WorkspaceStore(directory);
  let product = store.createProduct();
  product = store.saveProduct({ id: product.id, revision: product.revision, title: 'Cotton source', sourceUrl: '', description: '', status: product.status, variants: product.variants.map(({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory }) => ({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory })), facts: [{ id: randomUUID(), name: 'Material', value: 'Cotton', source: 'manual', sourceRef: '', state: 'human_confirmed' }] });
  const bytes = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes); bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12); bytes.writeUInt32BE(256, 16); bytes.writeUInt32BE(256, 20);
  const source = join(directory, 'source.png'); await writeFile(source, bytes);
  product = await importImageFiles(store, directory, { productId: product.id, revision: product.revision }, [source], b => b);
  product = store.updateAsset({ productId: product.id, revision: product.revision, assetId: product.assets[0].id, role: 'main', variantIds: [product.variants[0].id] });
  let remote: number | null = null;
  const hosting = new HostingService(directory, store, storage, { transport: { async size() { return remote; }, async upload(_p, _c, _path, data) { remote = data.length; return remote; }, async close() {} }, probe: async () => {} });
  hosting.importProfile({ id: 'alpha', host: 'fixture.example.test', port: 2121, secure: false, username: 'fixture-user', password: 'fixture-password', remoteRoot: '/', publicBaseUrl: 'https://htc.185858.xyz/AAA/' }); hosting.setEnabled({ id: 'alpha', enabled: true });
  const requests: { url: string; options?: RequestInit }[] = [];
  let responder = dependencies.fetch ?? (async (url, options) => responseFor(String(url), options)) as typeof fetch;
  const service = new AiService(directory, store, hosting, storage, { ...dependencies, fetch: async (url, options) => { requests.push({ url: String(url), options }); return responder(url, options); } });
  let storeClosed = false; const closeStore = () => { if (!storeClosed) { store.close(); storeClosed = true; } };
  t.after(async () => { await service.close(); await hosting.close(); closeStore(); await rm(directory, { recursive: true, force: true }); });
  const enable = (id: AiProviderId, model = id === 'deepseek-review' ? 'deepseek-v4-pro' : 'deepseek-flash') => { service.importProfile(id.startsWith('deepseek') ? { id, model, apiKey: 'fixture-api-key' } : { id, accessKeyId: 'fixture-key-id', accessKeySecret: 'fixture-key-secret' }); service.setEnabled({ id, enabled: true }); };
  const imageInput = { productId: product.id, productRevision: product.revision, assetId: product.assets[0].id };
  const textInput = { productId: product.id, productRevision: product.revision, variantId: product.variants[0].id, ocrResultIds: [] as string[] };
  const upload = () => hosting.upload({ assetId: imageInput.assetId, profileId: 'alpha', generation: hosting.getProfile('alpha').generation, batchId: randomUUID() });
  return { directory, store, closeStore, hosting, service, product, imageInput, textInput, enable, requests, upload, respond: (value: typeof fetch) => { responder = value; } };
}
