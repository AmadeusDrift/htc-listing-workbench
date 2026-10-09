import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, unlinkSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ImageVersion } from '../../shared/image-version-contracts.ts';
import { IMAGE_WRITE_CODES, IMAGE_WRITE_STATES } from '../../shared/image-write-contracts.ts';
import type { ImageWriteCode, ImageWriteRecoveryStatus, ImageWriteSummary } from '../../shared/image-write-contracts.ts';
import { AiError } from '../ai/errors.ts';
import { date, integer, keys, uuid } from '../ai/validation.ts';
import { managedAssetPath } from '../security.ts';
import { validateImageVersion } from './validation.ts';

export interface ImageWriteOperation extends ImageWriteSummary { candidate: ImageVersion | null }
export type ImageWriteCheckpoint = 'intent' | 'original-written' | 'preview-written' | 'committed';
const canonical = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
const attentionCodes = new Set<ImageWriteCode>(['INVALID_RECORD', 'INVALID_HISTORY', 'REGISTERED_PATH', 'VERSION_CONFLICT', 'UNSAFE_PATH', 'CONTENT_MISMATCH', 'IO_ERROR']);
const timestamp = (minimum: string) => new Date(Math.max(Date.now(), Date.parse(minimum))).toISOString();

export function validateImageWriteOperation(raw: unknown): ImageWriteOperation {
  const o = keys(raw, ['id', 'candidate', 'state', 'code', 'createdAt', 'updatedAt']), id = uuid(o.id);
  const candidate = o.candidate === null ? null : validateImageVersion(o.candidate), createdAt = date(o.createdAt), updatedAt = date(o.updatedAt);
  if (!IMAGE_WRITE_STATES.includes(o.state as ImageWriteOperation['state']) || !IMAGE_WRITE_CODES.includes(o.code as ImageWriteCode)
    || updatedAt < createdAt || (candidate && (candidate.id !== id || candidate.createdAt !== createdAt))
    || (!candidate && (o.state !== 'NEEDS_ATTENTION' || o.code !== 'INVALID_RECORD'))
    || (o.state === 'WRITING' && (o.code !== 'WRITE_INTENT' || updatedAt !== createdAt))
    || (o.state === 'CLEANED' && o.code !== 'UNCOMMITTED_REMOVED')
    || (o.state === 'COMMITTED' && o.code !== 'VERSION_COMMITTED')
    || (o.state === 'NEEDS_ATTENTION' && !attentionCodes.has(o.code as ImageWriteCode))) throw new AiError('INVALID_CONFIG');
  return { id, candidate, state: o.state as ImageWriteOperation['state'], code: o.code as ImageWriteCode, createdAt, updatedAt };
}

class RecoveryIssue extends Error {
  readonly code: ImageWriteCode;
  constructor(code: ImageWriteCode) { super(code); this.code = code; }
}
const missing = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && b.nlink === 1;

/** Recovery is synchronous: it finishes before the service can accept save or selection calls. */
export class ImageWriteRecovery {
  private root: string;
  private db: DatabaseSync;
  constructor(root: string, db: DatabaseSync) { this.root = resolve(root); this.db = db; }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  private records(): ImageWriteOperation[] {
    return this.db.prepare('SELECT id,record_json FROM image_write_operations ORDER BY rowid DESC').all().map(row => {
      const record = validateImageWriteOperation(JSON.parse(String(row.record_json)));
      if (record.id !== row.id) throw new AiError('INVALID_CONFIG'); return record;
    });
  }
  status(rawLimit = 20): ImageWriteRecoveryStatus {
    const limit = integer(rawLimit, 1, 100), records = this.records(), counts = { WRITING: 0, CLEANED: 0, COMMITTED: 0, NEEDS_ATTENTION: 0 };
    for (const record of records) counts[record.state]++;
    return { total: records.length, counts, items: records.slice(0, limit).map(({ id, state, code, createdAt, updatedAt }) => ({ id, state, code, createdAt, updatedAt })) };
  }
  begin(raw: ImageVersion): ImageVersion {
    return this.transaction(() => {
      const versions = this.db.prepare('SELECT record_json FROM image_versions').all().map(row => validateImageVersion(JSON.parse(String(row.record_json))));
      const reserved = this.records().flatMap(record => record.state === 'WRITING' && record.candidate ? [record.candidate] : []);
      const sequence = [...versions, ...reserved].filter(v => v.productId === raw.productId && v.sourceAssetId === raw.sourceAssetId).reduce((maximum, v) => Math.max(maximum, v.version), 0) + 1;
      const candidate = validateImageVersion({ ...raw, version: sequence });
      const operation = validateImageWriteOperation({ id: candidate.id, candidate, state: 'WRITING', code: 'WRITE_INTENT', createdAt: candidate.createdAt, updatedAt: candidate.createdAt });
      this.db.prepare('INSERT INTO image_write_operations VALUES(?,?)').run(operation.id, JSON.stringify(operation));
      return candidate;
    });
  }
  commit(candidate: ImageVersion): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT record_json FROM image_write_operations WHERE id=?').get(candidate.id);
      const operation = row && validateImageWriteOperation(JSON.parse(String(row.record_json)));
      if (!operation || operation.state !== 'WRITING' || JSON.stringify(operation.candidate) !== JSON.stringify(candidate)) throw new AiError('INVALID_CONFIG');
      this.db.prepare('INSERT INTO image_versions VALUES(?,?)').run(candidate.id, JSON.stringify(candidate));
      this.finish(operation, 'COMMITTED', 'VERSION_COMMITTED');
    });
  }
  private finish(operation: ImageWriteOperation, state: ImageWriteOperation['state'], code: ImageWriteCode): void {
    const record = validateImageWriteOperation({ ...operation, state, code, updatedAt: timestamp(operation.createdAt) });
    this.db.prepare('UPDATE image_write_operations SET record_json=? WHERE id=?').run(JSON.stringify(record), record.id);
  }
  private parentExists(): boolean {
    const root = lstatSync(this.root);
    if (!root.isDirectory() || root.isSymbolicLink() || canonical(realpathSync(this.root)) !== canonical(this.root)) throw new RecoveryIssue('UNSAFE_PATH');
    const directory = join(this.root, 'assets');
    let stat: Stats;
    try { stat = lstatSync(directory); } catch (error) { if (missing(error)) return false; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || canonical(realpathSync(directory)) !== canonical(directory)) throw new RecoveryIssue('UNSAFE_PATH');
    return true;
  }
  private inspect(path: string, expectedHash: string, expectedSize: number): Stats | null {
    if (!this.parentExists()) return null;
    const destination = managedAssetPath(this.root, path);
    let before: Stats;
    try { before = lstatSync(destination); } catch (error) { if (missing(error)) return null; throw error; }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || canonical(realpathSync(destination)) !== canonical(destination)) throw new RecoveryIssue('UNSAFE_PATH');
    if (before.size !== expectedSize) throw new RecoveryIssue('CONTENT_MISMATCH');
    const file = openSync(destination, 'r');
    try {
      if (!sameFile(before, fstatSync(file))) throw new RecoveryIssue('UNSAFE_PATH');
      const bytes = Buffer.alloc(expectedSize); let offset = 0;
      while (offset < bytes.length) { const count = readSync(file, bytes, offset, bytes.length - offset, offset); if (!count) throw new RecoveryIssue('CONTENT_MISMATCH'); offset += count; }
      if (!sameFile(before, fstatSync(file)) || !sameFile(before, lstatSync(destination)) || canonical(realpathSync(destination)) !== canonical(destination)) throw new RecoveryIssue('UNSAFE_PATH');
      if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw new RecoveryIssue('CONTENT_MISMATCH');
      return before;
    } finally { closeSync(file); }
  }
  private resolvePending(operation: ImageWriteOperation): void {
    const candidate = operation.candidate!;
    const protectedPaths = new Set<string>(), versions: ImageVersion[] = [];
    try {
      for (const row of this.db.prepare('SELECT original_path,preview_path FROM assets').all()) {
        for (const file of [row.original_path, row.preview_path]) protectedPaths.add(canonical(managedAssetPath(this.root, String(file))));
      }
      for (const row of this.db.prepare('SELECT id,record_json FROM image_versions').all()) {
        const version = validateImageVersion(JSON.parse(String(row.record_json)));
        if (version.id !== row.id) throw new Error('Invalid identity'); versions.push(version);
        for (const path of [version.originalPath, version.previewPath]) protectedPaths.add(canonical(managedAssetPath(this.root, path)));
      }
    } catch { throw new RecoveryIssue('INVALID_HISTORY'); }
    const registered = versions.find(version => version.id === candidate.id);
    if (registered) {
      if (JSON.stringify(registered) !== JSON.stringify(candidate)) throw new RecoveryIssue('VERSION_CONFLICT');
      this.finish(operation, 'COMMITTED', 'VERSION_COMMITTED'); return;
    }
    const files = [[candidate.originalPath, candidate.sha256, candidate.byteSize], [candidate.previewPath, candidate.previewSha256, candidate.previewByteSize]] as const;
    if (files.some(([path]) => protectedPaths.has(canonical(managedAssetPath(this.root, path))))) throw new RecoveryIssue('REGISTERED_PATH');
    // Prove both files safe before removing either. Unknown or damaged siblings are kept together.
    const verified = files.map(([path, hash, size]) => this.inspect(path, hash, size));
    for (let i = 0; i < files.length; i++) {
      const [path, hash, size] = files[i], prior = verified[i], current = this.inspect(path, hash, size);
      if (prior === null && current === null) continue;
      if (!prior || !current || !sameFile(prior, current)) throw new RecoveryIssue('UNSAFE_PATH');
      unlinkSync(managedAssetPath(this.root, path));
    }
    this.finish(operation, 'CLEANED', 'UNCOMMITTED_REMOVED');
  }
  recoverOne(id: string): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT id,record_json FROM image_write_operations WHERE id=?').get(id); if (!row) return;
      let operation: ImageWriteOperation;
      try {
        operation = validateImageWriteOperation(JSON.parse(String(row.record_json)));
        if (operation.id !== row.id) throw new AiError('INVALID_CONFIG');
      } catch {
        // A corrupt record cannot authorize any file operation. Retain files and only persist safe diagnostics.
        let safeId: string; try { safeId = uuid(row.id); } catch { safeId = randomUUID(); }
        const now = new Date().toISOString();
        operation = { id: safeId, candidate: null, state: 'NEEDS_ATTENTION', code: 'INVALID_RECORD', createdAt: now, updatedAt: now };
        this.db.prepare('UPDATE image_write_operations SET id=?,record_json=? WHERE id=?').run(safeId, JSON.stringify(operation), row.id); return;
      }
      if (operation.state !== 'WRITING') return;
      try { this.resolvePending(operation); }
      catch (error) { this.finish(operation, 'NEEDS_ATTENTION', error instanceof RecoveryIssue ? error.code : 'IO_ERROR'); }
    });
  }
  recover(): ImageWriteRecoveryStatus {
    for (const row of this.db.prepare('SELECT id FROM image_write_operations ORDER BY rowid').all()) this.recoverOne(String(row.id));
    return this.status();
  }
}
