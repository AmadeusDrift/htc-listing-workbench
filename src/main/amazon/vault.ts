import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { UserFacingError } from '../../shared/errors.ts';
import { marketplace, object, textField } from './context.ts';
import type { AmazonTarget } from '../../shared/amazon-contracts.ts';
import type { CredentialReadState } from '../../shared/credential-status.ts';

export interface SecretStorage { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
export interface Credentials { name: string; sellerId: string; marketplaceId: string; region: AmazonTarget['region']; locale: string; clientId: string; clientSecret: string; refreshToken: string }
export function parseCredentials(raw: unknown): Credentials {
  const value = object(raw, '授权配置');
  const keys = ['name', 'sellerId', 'marketplaceId', 'region', 'locale', 'clientId', 'clientSecret', 'refreshToken'];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw new UserFacingError('授权配置字段不完整或包含不支持的字段，请检查连接表单或配置文件');
  const parsed = Object.fromEntries(keys.map(key => [key, textField(value[key], '授权配置字段', key === 'name' ? 100 : 4096)])) as unknown as Credentials;
  if (!['na', 'eu', 'fe'].includes(parsed.region)) throw new UserFacingError('Amazon 区域无效');
  marketplace(parsed.marketplaceId, parsed.region);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(parsed.sellerId) || !/^[a-z]{2}(?:_[A-Z]{2})?$/.test(parsed.locale)) throw new UserFacingError('卖家 ID 或语言格式无效');
  const metadata = [parsed.name, parsed.sellerId, parsed.marketplaceId, parsed.region, parsed.locale];
  if ([parsed.clientId, parsed.clientSecret, parsed.refreshToken].some(secret => metadata.some(value => value.includes(secret)))) throw new UserFacingError('授权配置的公开字段中不能包含敏感凭据');
  return parsed;
}
export class CredentialVault {
  private directory: string;
  private storage: SecretStorage;
  private redactions = new Set<string>();
  constructor(directory: string, storage: SecretStorage) { this.directory = join(directory, 'amazon-vault'); this.storage = storage; }
  private path(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new UserFacingError('授权记录 ID 无效');
    return join(this.directory, `${id}.bin`);
  }
  remember(value: string): void { if (value) this.redactions.add(value); }
  private writeEncrypted(id: string, encrypted: Buffer): void {
    mkdirSync(this.directory, { recursive: true }); const temporary = join(this.directory, `${id}.${randomUUID()}.tmp`);
    try { writeFileSync(temporary, encrypted, { flag: 'wx', mode: 0o600 }); renameSync(temporary, this.path(id)); }
    catch { throw new UserFacingError('授权加密文件无法写入，请检查数据目录权限'); }
    finally { rmSync(temporary, { force: true }); }
  }
  write(id: string, credentials: Credentials, generation: number): () => void {
    if (!this.storage.isEncryptionAvailable()) throw new UserFacingError('系统安全加密不可用，无法保存 Amazon 授权配置');
    let encrypted: Buffer;
    try { encrypted = this.storage.encryptString(JSON.stringify({ version: 1, generation, credentials })); } catch { throw new UserFacingError('系统安全加密失败，授权配置未保存'); }
    const previous = this.has(id) ? readFileSync(this.path(id)) : null;
    this.writeEncrypted(id, encrypted);
    for (const secret of [credentials.clientId, credentials.clientSecret, credentials.refreshToken]) this.remember(secret);
    return () => { if (previous) this.writeEncrypted(id, previous); else this.remove(id); };
  }
  read(id: string, expectedGeneration: number): Credentials {
    const result = this.inspect(id, expectedGeneration);
    if (result.state !== 'readable') throw new UserFacingError('授权文件不可用或无法解密，请先检查原 Windows 用户和工作区；需要更换凭据时再重新填写或导入');
    return result.credentials;
  }
  inspect(id: string, expectedGeneration: number): { state: 'readable'; credentials: Credentials } | { state: Exclude<CredentialReadState, 'readable'> } {
    try {
      const path = this.path(id); if (!existsSync(path)) return { state: 'absent' };
      const metadata = statSync(path); if (!metadata.isFile() || metadata.size < 1 || metadata.size > 65536) return { state: 'unreadable' };
      if (!this.storage.isEncryptionAvailable()) return { state: 'encryption-unavailable' };
      const envelope = object(JSON.parse(this.storage.decryptString(readFileSync(path))), '授权文件');
      if (envelope.version !== 1 || envelope.generation !== expectedGeneration) return { state: 'metadata-mismatch' };
      const value = parseCredentials(envelope.credentials);
      for (const secret of [value.clientId, value.clientSecret, value.refreshToken]) this.remember(secret);
      return { state: 'readable', credentials: value };
    } catch { return { state: 'unreadable' }; }
  }
  savedIds(): string[] {
    try { return existsSync(this.directory) ? readdirSync(this.directory).filter(name => /^[0-9a-f-]{36}\.bin$/.test(name)).map(name => name.slice(0, -4)) : []; }
    catch { throw new UserFacingError('无法检查本机授权文件目录，请检查工作区读取权限'); }
  }
  has(id: string): boolean { return existsSync(this.path(id)); }
  remove(id: string): void { rmSync(this.path(id), { force: true }); }
  redact<T>(value: T): T {
    const scrub = (text: string): string => { let result = text; for (const secret of this.redactions) result = result.replaceAll(secret, '[REDACTED]'); return result; };
    const walk = (node: unknown): unknown => {
      if (typeof node === 'string') return scrub(node);
      if (Array.isArray(node)) return node.map(walk);
      if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, child]) => [scrub(key), /client.?secret|refresh.?token|access.?token|authorization|client.?id/i.test(key) ? '[REDACTED]' : walk(child)]));
      return node;
    };
    return walk(value) as T;
  }
}
