import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SecretStorage } from '../amazon/vault.ts';
import { AiError } from '../ai/errors.ts';
import { keys } from '../ai/validation.ts';
import { DEFAULT_OPENAI_IMAGE_MODEL, DEFAULT_TYAI_IMAGE_MODEL, OPENAI_IMAGE_MODELS } from '../../shared/image-generation-contracts.ts';
import { validRelayModelId, isGeminiImageModel, geminiImageConfig } from '../../shared/image-models.ts';
import type { ImageGenerationConnection, ImageGenerationModel, ImageGenerationProvider, ImageGenerationQuality, ImageGenerationSize, OpenAiImageModel } from '../../shared/image-generation-contracts.ts';

export interface ImageGenerationConfig { provider: ImageGenerationProvider; model: ImageGenerationModel; enabled: boolean; apiKey: string; size: ImageGenerationSize; quality: ImageGenerationQuality }
export function imageProvider(raw: unknown): ImageGenerationProvider {
  if (raw !== 'openai' && raw !== 'tyai') throw new AiError('INVALID_CONFIG');
  return raw;
}
export function imageModel(raw: unknown, provider: ImageGenerationProvider = 'openai'): ImageGenerationModel {
  if (typeof raw !== 'string' || !(provider === 'openai' ? OPENAI_IMAGE_MODELS.includes(raw as OpenAiImageModel) : validRelayModelId(raw))) throw new AiError('INVALID_CONFIG');
  return raw as ImageGenerationModel;
}
export function imageQuality(raw: unknown): ImageGenerationQuality {
  if (typeof raw !== 'string' || !['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(raw)) throw new AiError('INVALID_CONFIG');
  return raw as ImageGenerationQuality;
}
export function validImageSize(raw: unknown, provider: ImageGenerationProvider, model = ''): raw is ImageGenerationSize {
  if (typeof raw !== 'string') return false;
  if (raw === 'auto') return true;
  if (provider === 'openai') return ['1024x1024', '1536x1024', '1024x1536'].includes(raw);
  if (isGeminiImageModel(model)) return !!geminiImageConfig(raw as ImageGenerationSize);
  if (!/^[1-9]\d{2,3}x[1-9]\d{2,3}$/.test(raw)) return false;
  const [width, height] = raw.split('x').map(Number), small = Math.min(width, height), large = Math.max(width, height), pixels = width * height;
  return width % 16 === 0 && height % 16 === 0 && small >= 512 && large <= 3840 && large / small <= 3 && pixels >= 1024 * 1024 && pixels <= 3840 * 2160;
}
export function imageDefaults(provider: ImageGenerationProvider): Pick<ImageGenerationConfig, 'model' | 'size' | 'quality'> {
  return provider === 'openai' ? { model: DEFAULT_OPENAI_IMAGE_MODEL, size: 'auto', quality: 'auto' } : { model: DEFAULT_TYAI_IMAGE_MODEL, size: '1024x1024', quality: 'max' };
}
export function imageApiKey(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 4096 || /[^\x21-\x7e]/.test(raw.trim())) throw new AiError('INVALID_CONFIG');
  return raw.trim();
}
/** All child directories here are application-owned; never follow a substituted link. */
export function privateDirectory(parent: string, name: string, create = false): string {
  const path = join(parent, name);
  if (!existsSync(path) && create) mkdirSync(path);
  if (existsSync(path)) { const info = lstatSync(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new AiError('INVALID_CONFIG'); }
  return path;
}
function privateFile(directory: string, name: string, create = false): string {
  const path = join(privateDirectory(directory, 'ai-vault', create), name);
  if (existsSync(path)) { const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new AiError('INVALID_CONFIG'); }
  return path;
}
function writePrivateFile(path: string, bytes: Buffer): void {
  let temporary: string | undefined;
  try {
    temporary = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path); temporary = undefined;
  } catch { throw new AiError('INVALID_CONFIG'); }
  finally { if (temporary) { try { unlinkSync(temporary); } catch { /* No plaintext credentials are written. */ } } }
}
/** Restore always clears every image credential, including inactive providers. */
export function clearImageGenerationConnection(directory: string): void {
  try {
    for (const name of ['openai-images.bin', 'tyai-images.bin', 'image-provider.json']) {
      const path = privateFile(directory, name); if (existsSync(path)) unlinkSync(path);
    }
  } catch { throw new AiError('INVALID_CONFIG'); }
}
export class ImageGenerationVault {
  private directory: string; private storage: SecretStorage;
  constructor(directory: string, storage: SecretStorage) { this.directory = directory; this.storage = storage; }
  activeProvider(): ImageGenerationProvider {
    try {
      const path = privateFile(this.directory, 'image-provider.json'); if (!existsSync(path)) return 'openai';
      if (lstatSync(path).size > 100) throw new Error();
      const raw = keys(JSON.parse(readFileSync(path, 'utf8')), ['version', 'provider']);
      if (raw.version !== 1) throw new Error();
      return imageProvider(raw.provider);
    } catch { throw new AiError('INVALID_CONFIG'); }
  }
  inspect(provider = this.activeProvider()): { state: 'ready'; config: ImageGenerationConfig } | { state: Exclude<ImageGenerationConnection['credentialState'], 'ready'> } {
    try {
      const path = privateFile(this.directory, `${imageProvider(provider)}-images.bin`); if (!existsSync(path)) return { state: 'absent' };
      if (!this.storage.isEncryptionAvailable()) return { state: 'encryption-unavailable' };
      const size = lstatSync(path).size; if (size < 1 || size > 65536) throw new Error();
      const raw = keys(JSON.parse(this.storage.decryptString(readFileSync(path))), ['version', 'provider', 'model', 'enabled', 'apiKey'], ['size', 'quality']);
      if (raw.version !== 1 || raw.provider !== provider || typeof raw.enabled !== 'boolean') throw new Error();
      const defaults = imageDefaults(provider), outputSize = raw.size ?? defaults.size;
      if (!validImageSize(outputSize, provider, String(raw.model))) throw new Error();
      return { state: 'ready', config: { provider, model: imageModel(raw.model, provider), enabled: raw.enabled, apiKey: imageApiKey(raw.apiKey), size: outputSize, quality: imageQuality(raw.quality ?? defaults.quality) } };
    } catch { return { state: 'unreadable' }; }
  }
  save(config: ImageGenerationConfig): void {
    let encrypted: Buffer;
    try {
      if (!this.storage.isEncryptionAvailable()) throw new Error();
      encrypted = this.storage.encryptString(JSON.stringify({ version: 1, ...config }));
    } catch { throw new AiError('ENCRYPTION_UNAVAILABLE'); }
    writePrivateFile(privateFile(this.directory, `${config.provider}-images.bin`, true), encrypted);
    writePrivateFile(privateFile(this.directory, 'image-provider.json', true), Buffer.from(JSON.stringify({ version: 1, provider: config.provider })));
  }
  remove(provider = this.activeProvider()): void {
    try { const path = privateFile(this.directory, `${imageProvider(provider)}-images.bin`); if (existsSync(path)) unlinkSync(path); }
    catch { throw new AiError('INVALID_CONFIG'); }
  }
}
