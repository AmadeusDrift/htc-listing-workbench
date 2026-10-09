import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SecretStorage } from '../amazon/vault.ts';
import type { HostingProfileId } from '../../shared/hosting-contracts.ts';
import { HostingError } from './errors.ts';
import type { HostingCredentials } from './validation.ts';
import { objectKeys, profileId } from './validation.ts';

export class HostingVault {
  private directory: string;
  private storage: SecretStorage;
  constructor(directory: string, storage: SecretStorage) { this.directory = join(directory, 'hosting-vault'); this.storage = storage; }
  private path(id: HostingProfileId): string { return join(this.directory, `${profileId(id)}.bin`); }
  private writeBytes(id: HostingProfileId, bytes: Buffer): void {
    mkdirSync(this.directory, { recursive: true }); const temp = join(this.directory, `${id}.${randomUUID()}.tmp`);
    try { writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 }); renameSync(temp, this.path(id)); }
    catch { throw new HostingError('CREDENTIAL_NOT_FOUND'); }
    finally { rmSync(temp, { force: true }); }
  }
  write(id: HostingProfileId, credentials: HostingCredentials, generation: number): () => void {
    if (!this.storage.isEncryptionAvailable()) throw new HostingError('ENCRYPTION_UNAVAILABLE');
    let bytes: Buffer; try { bytes = this.storage.encryptString(JSON.stringify({ version: 1, id, generation, credentials })); } catch { throw new HostingError('ENCRYPTION_UNAVAILABLE'); }
    const previous = existsSync(this.path(id)) ? readFileSync(this.path(id)) : null;
    this.writeBytes(id, bytes);
    return () => { if (previous) this.writeBytes(id, previous); else rmSync(this.path(id), { force: true }); };
  }
  read(id: HostingProfileId, generation: number): HostingCredentials {
    try {
      if (!this.storage.isEncryptionAvailable()) throw new Error();
      const o = objectKeys(JSON.parse(this.storage.decryptString(readFileSync(this.path(id)))), ['version', 'id', 'generation', 'credentials']);
      if (o.version !== 1 || o.id !== id || o.generation !== generation) throw new Error();
      const c = objectKeys(o.credentials, ['username', 'password']);
      if ([c.username, c.password].some(value => typeof value !== 'string' || !value.length || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value))) throw new Error();
      return { username: c.username as string, password: c.password as string };
    } catch { throw new HostingError('CREDENTIAL_NOT_FOUND'); }
  }
  has(id: HostingProfileId, generation: number): boolean { try { this.read(id, generation); return true; } catch { return false; } }
}
