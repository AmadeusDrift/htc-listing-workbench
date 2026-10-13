import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SecretStorage } from '../amazon/vault.ts';
import type { AiProviderId } from '../../shared/ai-contracts.ts';
import type { CredentialReadState } from '../../shared/credential-status.ts';
import { AiError } from './errors.ts';
import { isChatProvider, keys, MODELS, parseProfileImport, providerId } from "./primitives.ts";
import type { AiCredentials } from "./primitives.ts";

/** Separate from all other connection vaults, and bound to both provider ID and generation. */
export class AiVault {
  private directory: string;
  private storage: SecretStorage;
  constructor(directory: string, storage: SecretStorage) { this.directory = join(directory, 'ai-vault'); this.storage = storage; }
  private path(id: AiProviderId): string { return join(this.directory, `${providerId(id)}.bin`); }
  private bytes(id: AiProviderId): Buffer | null {
    try { const path = this.path(id); if (!existsSync(path)) return null; const size = statSync(path).size; if (size < 1 || size > 65536) throw new Error(); return readFileSync(path); }
    catch { throw new AiError('NOT_CONFIGURED'); }
  }
  private replace(id: AiProviderId, bytes: Buffer | null): void {
    const temporary = join(this.directory, `${id}.${randomUUID()}.tmp`);
    try {
      if (bytes === null) { rmSync(this.path(id), { force: true }); return; }
      mkdirSync(this.directory, { recursive: true }); writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 }); renameSync(temporary, this.path(id));
    } catch { throw new AiError('NOT_CONFIGURED'); }
    finally { try { rmSync(temporary, { force: true }); } catch { /* Ciphertext temporary files contain no plaintext. */ } }
  }
  write(id: AiProviderId, credentials: AiCredentials, generation: number): () => void {
    let encrypted: Buffer;
    try { if (!this.storage.isEncryptionAvailable()) throw new Error(); encrypted = this.storage.encryptString(JSON.stringify({ version: 1, id, generation, credentials })); }
    catch { throw new AiError('ENCRYPTION_UNAVAILABLE'); }
    const previous = this.bytes(id); this.replace(id, encrypted); return () => this.replace(id, previous);
  }
  read(id: AiProviderId, generation: number): AiCredentials {
    const result = this.inspect(id, generation);
    if (result.state !== 'readable') throw new AiError('NOT_CONFIGURED');
    return result.credentials;
  }
  inspect(id: AiProviderId, generation: number): { state: 'readable'; credentials: AiCredentials } | { state: Exclude<CredentialReadState, 'readable'> } {
    try {
      const bytes = this.bytes(id); if (!bytes) return { state: 'absent' };
      if (!this.storage.isEncryptionAvailable()) return { state: 'encryption-unavailable' };
      const envelope = keys(JSON.parse(this.storage.decryptString(bytes)), ['version', 'id', 'generation', 'credentials']);
      if (envelope.version !== 1 || envelope.id !== id || envelope.generation !== generation) return { state: 'metadata-mismatch' };
      const credentials = isChatProvider(id) ? keys(envelope.credentials, ['apiKey']) : keys(envelope.credentials, ['accessKeyId', 'accessKeySecret'], ['securityToken']);
      return { state: 'readable', credentials: parseProfileImport({ id, ...(isChatProvider(id) ? { model: MODELS[id] } : {}), ...credentials }).credentials };
    } catch { return { state: 'unreadable' }; }
  }
  has(id: AiProviderId, generation: number): boolean { try { this.read(id, generation); return true; } catch { return false; } }
  remove(id: AiProviderId): () => void { const previous = this.bytes(id); this.replace(id, null); return () => this.replace(id, previous); }
}
