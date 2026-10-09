import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { UserFacingError } from '../shared/errors.ts';
import { writeFileAtomically } from './files.ts';

export interface BackupRetention { amazonDays: number; logDays: number; dataOldestAt: string | null; expiresAt: string | null }
export interface ManagedBackup { path: string; sha256: string; byteSize: number; createdAt: string; retention: BackupRetention }

interface Registry { version: 1; backups: ManagedBackup[] }
const MAGIC = Buffer.from('HTC-BACKUP-1\n');
const MAX_BACKUP_BYTES = 400 * 1024 * 1024;
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const DAY = 86_400_000;
const pending = new Map<string, Promise<unknown>>();

function pathKey(path: string): string { return process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path); }
function registryError(): UserFacingError { return new UserFacingError('备份管理记录无效或已损坏，请保留数据目录后联系维护人员'); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'; }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function validDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 30 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function validDays(value: unknown): value is number { return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 548; }
function validEntry(value: unknown): value is ManagedBackup {
  if (!record(value) || !hasKeys(value, ['path', 'sha256', 'byteSize', 'createdAt', 'retention'])) return false;
  if (typeof value.path !== 'string' || !isAbsolute(value.path) || value.path.includes('\0') || value.path.length > 32_768 || extname(value.path).toLowerCase() !== '.htcbackup') return false;
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.byteSize) || Number(value.byteSize) < MAGIC.length + 44 || Number(value.byteSize) > MAX_BACKUP_BYTES || !validDate(value.createdAt)) return false;
  const policy = value.retention;
  if (!record(policy) || !hasKeys(policy, ['amazonDays', 'logDays', 'dataOldestAt', 'expiresAt']) || !validDays(policy.amazonDays) || !Number.isSafeInteger(policy.logDays) || Number(policy.logDays) < 365) return false;
  if (policy.dataOldestAt !== null && !validDate(policy.dataOldestAt)) return false;
  if (policy.expiresAt !== null && !validDate(policy.expiresAt)) return false;
  return policy.dataOldestAt === null || policy.expiresAt !== null;
}
function sameFile(first: Stats, second: Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino && first.size === second.size && first.mtimeMs === second.mtimeMs && first.ctimeMs === second.ctimeMs;
}
async function regularFile(path: string): Promise<Stats> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || pathKey(await realpath(path)) !== pathKey(path)) throw registryError();
  return info;
}
async function safeDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || pathKey(await realpath(path)) !== pathKey(path)) throw registryError();
}
async function serialized<T>(directory: string, operation: (root: string) => Promise<T>): Promise<T> {
  const root = resolve(directory), key = pathKey(root);
  const work = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(() => operation(root));
  pending.set(key, work);
  try { return await work; }
  finally { if (pending.get(key) === work) pending.delete(key); }
}

async function readRegistry(root: string): Promise<Registry> {
  const path = join(root, '.backup-registry.json');
  let before: Stats;
  try {
    await safeDirectory(root);
    before = await regularFile(path);
  } catch (error) {
    if (missing(error)) return { version: 1, backups: [] };
    throw registryError();
  }
  if (before.size > MAX_REGISTRY_BYTES) throw registryError();
  try {
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!sameFile(before, await file.stat())) throw registryError();
      const bytes = Buffer.alloc(before.size + 1); let length = 0;
      while (length < bytes.length) {
        const result = await file.read(bytes, length, bytes.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length !== before.size || !sameFile(before, await file.stat()) || !sameFile(before, await regularFile(path))) throw registryError();
      const value: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'));
      if (!record(value) || !hasKeys(value, ['version', 'backups']) || value.version !== 1 || !Array.isArray(value.backups) || value.backups.length > MAX_ENTRIES || !value.backups.every(validEntry)) throw registryError();
      const paths = new Set(value.backups.map(entry => pathKey(entry.path)));
      if (paths.size !== value.backups.length) throw registryError();
      return { version: 1, backups: value.backups };
    } finally { await file.close(); }
  } catch { throw registryError(); }
}

async function writeRegistry(root: string, registry: Registry): Promise<void> {
  const contents = JSON.stringify(registry), path = join(root, '.backup-registry.json');
  if (registry.backups.length > MAX_ENTRIES || Buffer.byteLength(contents) > MAX_REGISTRY_BYTES) throw new UserFacingError('受管备份记录数量已达上限，请先整理备份');
  await safeDirectory(root);
  try { await regularFile(path); } catch (error) { if (!missing(error)) throw error; }
  await writeFileAtomically(path, contents);
}

/** Register the final encrypted bytes before their atomic export, including a currently absent destination. */
export async function registerManagedBackup(directory: string, entry: ManagedBackup): Promise<void> {
  if (!validEntry(entry)) throw new UserFacingError('备份管理信息不完整或保留期限无效');
  // Copy before awaiting so a caller cannot change a queued registration's ownership evidence.
  const saved: ManagedBackup = { ...entry, path: resolve(entry.path), retention: { ...entry.retention } };
  await serialized(directory, async root => {
    const registry = await readRegistry(root);
    await safeDirectory(dirname(saved.path));
    try { await regularFile(saved.path); } catch (error) { if (!missing(error)) throw error; }
    const existing = registry.backups.findIndex(backup => pathKey(backup.path) === pathKey(saved.path));
    if (existing >= 0) {
      const previous = registry.backups[existing];
      if (previous.sha256 === saved.sha256 && previous.byteSize === saved.byteSize && previous.retention.expiresAt !== null) {
        const expiry = Math.min(Date.parse(previous.retention.expiresAt), saved.retention.expiresAt === null ? Infinity : Date.parse(saved.retention.expiresAt));
        saved.retention.expiresAt = new Date(expiry).toISOString();
      }
      registry.backups[existing] = saved;
    } else registry.backups.push(saved);
    await writeRegistry(root, registry);
  });
}

async function removeMatchingBackup(entry: ManagedBackup): Promise<boolean> {
  try {
    const before = await regularFile(entry.path);
    if (before.size !== entry.byteSize || before.size > MAX_BACKUP_BYTES) return false;
    const file = await open(entry.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!sameFile(before, await file.stat())) return false;
      const header = Buffer.alloc(MAGIC.length);
      if ((await file.read(header, 0, header.length, 0)).bytesRead !== MAGIC.length || !header.equals(MAGIC)) return false;
      const hash = createHash('sha256'), chunk = Buffer.alloc(64 * 1024); let offset = 0;
      while (offset < entry.byteSize) {
        const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, entry.byteSize - offset), offset);
        if (!bytesRead) return false;
        hash.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
      }
      if (hash.digest('hex') !== entry.sha256 || !sameFile(before, await file.stat()) || !sameFile(before, await regularFile(entry.path))) return false;
      await unlink(entry.path);
      return true;
    } finally { await file.close().catch(() => {}); }
  } catch {
    // Missing, inaccessible, changed, and linked destinations may be a pending atomic export.
    // Keep their ownership evidence so a later startup can retry without following moved copies.
    return false;
  }
}

/** Remove only registered encrypted exports; expiry never increases when the current policy changes. */
export async function cleanupManagedBackups(directory: string, retentionDays: number, now = Date.now()): Promise<number> {
  if (!validDays(retentionDays) || !Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) throw new UserFacingError('备份清理的保留期限或时间无效');
  return serialized(directory, async root => {
    const registry = await readRegistry(root), remaining: ManagedBackup[] = [];
    let deleted = 0, changed = false;
    for (const entry of registry.backups) {
      const policy = entry.retention;
      if (policy.expiresAt === null) { remaining.push(entry); continue; }
      let expiry = Date.parse(policy.expiresAt);
      if (policy.dataOldestAt !== null) expiry = Math.min(expiry, Date.parse(policy.dataOldestAt) + retentionDays * DAY);
      const deadline = new Date(expiry).toISOString();
      if (policy.expiresAt !== deadline) { policy.expiresAt = deadline; changed = true; }
      if (expiry <= now && await removeMatchingBackup(entry)) { deleted++; changed = true; }
      else remaining.push(entry);
    }
    if (changed) await writeRegistry(root, { version: 1, backups: remaining });
    return deleted;
  });
}
