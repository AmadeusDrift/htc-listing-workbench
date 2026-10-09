import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { SecretStorage } from '../amazon/vault.ts';
import type { MiaoshouMode } from '../../shared/miaoshou-contracts.ts';
import { exact, fail, MiaoshouError } from './validation.ts';

export interface MiaoshouCredentials { appKey: string; appSecret: string }
export const MIAOSHOU_CONFIG_TEMPLATE = Object.freeze({ appKey: 'YOUR_MIAOSHOU_APP_KEY', appSecret: 'YOUR_MIAOSHOU_APP_SECRET' });
/** Restore deliberately leaves the integration unconfigured, including interrupted restores. */
export function clearMiaoshouConfig(directory: string): void {
  try { rmSync(join(directory, 'miaoshou-vault', 'state.json'), { force: true }); rmSync(join(directory, 'miaoshou-vault', 'credentials.bin'), { force: true }); }
  catch { return fail('STORAGE'); }
}
export function parseCredentials(raw: unknown): MiaoshouCredentials {
  const config = exact(raw, ['appKey', 'appSecret'], 'CONFIG');
  for (const [key, max] of [['appKey', 256], ['appSecret', 4096]] as const) {
    if (typeof config[key] !== 'string' || config[key].length < 8 || config[key].length > max || !/^[\x21-\x7e]+$/.test(config[key]) || /YOUR_MIAOSHOU_|REPLACE_|请填写|请替换/.test(config[key])) return fail('CONFIG');
  }
  return { appKey: config.appKey as string, appSecret: config.appSecret as string };
}

/** Credentials stay in one OS-encrypted file; the small state file contains only the mode. */
export class MiaoshouVault {
  private directory: string;
  private storage: SecretStorage;
  constructor(directory: string, storage: SecretStorage) { this.directory = join(directory, 'miaoshou-vault'); this.storage = storage; }
  private path(name: 'credentials.bin' | 'state.json'): string { return join(this.directory, name); }
  private read(name: 'credentials.bin' | 'state.json'): Buffer | null {
    const path = this.path(name); if (!existsSync(path)) return null;
    if (!statSync(path).isFile() || statSync(path).size > (name === 'state.json' ? 256 : 32768)) return fail('STORAGE');
    return readFileSync(path);
  }
  private atomic(name: 'credentials.bin' | 'state.json', value: Buffer): void {
    mkdirSync(this.directory, { recursive: true }); const temporary = join(this.directory, `${name}.${randomUUID()}.tmp`);
    try { writeFileSync(temporary, value, { flag: 'wx', mode: 0o600 }); renameSync(temporary, this.path(name)); }
    finally { rmSync(temporary, { force: true }); }
  }
  private state(mode: MiaoshouMode): void { this.atomic('state.json', Buffer.from(JSON.stringify({ version: 1, mode }), 'utf8')); }
  load(): { mode: MiaoshouMode; credentials: MiaoshouCredentials | null } {
    let mode: MiaoshouMode = 'unconfigured';
    try {
      const bytes = this.read('state.json'); if (bytes) { const state = exact(JSON.parse(bytes.toString('utf8')), ['version', 'mode']); if (state.version !== 1 || !['demo', 'live', 'unconfigured'].includes(String(state.mode))) return fail('STORAGE'); mode = state.mode as MiaoshouMode; }
    } catch { return { mode: 'unconfigured', credentials: null }; }
    // A missing/disconnected state cannot reactivate a ciphertext copied from another workspace.
    if (mode === 'unconfigured') return { mode, credentials: null };
    try {
      const bytes = this.read('credentials.bin'); if (!bytes) return { mode: mode === 'demo' ? 'demo' : 'unconfigured', credentials: null };
      if (!this.storage.isEncryptionAvailable()) return fail('CRYPTO');
      const envelope = exact(JSON.parse(this.storage.decryptString(bytes)), ['version', 'credentials'], 'CONFIG'); if (envelope.version !== 1) return fail('CONFIG');
      return { mode, credentials: parseCredentials(envelope.credentials) };
    } catch { return { mode: mode === 'demo' ? 'demo' : 'unconfigured', credentials: null }; }
  }
  write(credentials: MiaoshouCredentials): void {
    let encrypted: Buffer;
    try { if (!this.storage.isEncryptionAvailable()) return fail('CRYPTO'); encrypted = this.storage.encryptString(JSON.stringify({ version: 1, credentials })); if (!encrypted.length || encrypted.length > 32768) return fail('CRYPTO'); }
    catch { return fail('CRYPTO'); }
    let previous: Buffer | null;
    try { previous = this.read('credentials.bin'); this.atomic('credentials.bin', encrypted); }
    catch { return fail('STORAGE'); }
    try { this.state('live'); }
    catch {
      try { if (previous) this.atomic('credentials.bin', previous); else rmSync(this.path('credentials.bin'), { force: true }); } catch { /* Both states remain disabled in memory if persistence fails. */ }
      return fail('STORAGE');
    }
  }
  setMode(mode: 'demo' | 'live'): void { try { this.state(mode); } catch { return fail('STORAGE'); } }
  disconnect(): void {
    try { this.state('unconfigured'); rmSync(this.path('credentials.bin'), { force: true }); }
    catch { return fail('STORAGE'); }
  }
}
export function redactCredentials<T>(value: T, credentials: MiaoshouCredentials): T {
  const replace = (value: string): string => value.replaceAll(credentials.appSecret, '已隐藏').replaceAll(credentials.appKey, '已隐藏');
  const visit = (raw: unknown, depth: number): unknown => {
    if (depth > 32) throw new MiaoshouError('RESPONSE');
    if (typeof raw === 'string') return replace(raw);
    if (Array.isArray(raw)) return raw.map(child => visit(child, depth + 1));
    if (raw && typeof raw === 'object') return Object.fromEntries(Object.entries(raw).map(([key, child]) => [replace(key), visit(child, depth + 1)]));
    return raw;
  };
  return visit(value, 0) as T;
}
