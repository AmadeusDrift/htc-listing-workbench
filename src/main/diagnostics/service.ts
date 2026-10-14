import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstatSync, readFileSync } from 'node:fs';
import type { RunReportContext } from '../../shared/run-report-contracts.ts';
import type { Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SCHEMA_VERSION } from '../database.ts';
import { IMAGE_WRITE_CODES, IMAGE_WRITE_STATES } from '../../shared/image-write-contracts.ts';
import type { ImageWriteCode, ImageWriteState } from '../../shared/image-write-contracts.ts';
import type { DiagnosticAssetKind, DiagnosticAssetStatus, DiagnosticErrorCode, DiagnosticServices, LocalDiagnosticReport } from '../../shared/diagnostic-contracts.ts';

export interface DiagnosticContext {
  appVersion: string;
  runtime: { nodeMajor: number; electronMajor: number };
  services: DiagnosticServices;
}
/** Packaged provenance is a reported build identity, not an on-demand binary verification. */
export function readRunReportBuildContext(appVersion: string, appPath: string): RunReportContext {
  const context: RunReportContext = { appVersion };
  try {
    const path = resolve(appPath, '..', '..', '版本与摘要.json'), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4*1024*1024) return context;
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    if (manifest.schema !== 'htc-package/v1') return context;
    if (/^[a-f0-9]{40}$/.test(manifest.source?.commit ?? '')) context.sourceCommit = manifest.source.commit;
    if (/^[a-f0-9]{64}$/.test(manifest.source?.sourceDigest ?? '')) context.sourceDigest = manifest.source.sourceDigest;
    if (manifest.build?.schema === 'htc-build/v1' && manifest.build.sourceCommit === context.sourceCommit) context.buildDigest = createHash('sha256').update(JSON.stringify(manifest.build)).digest('hex');
  } catch { /* Dev/legacy packages explicitly report missing build source. */ }
  return context;
}
const tables = { products: 'products', assets: 'assets', aiCalls: 'ai_calls', aiResults: 'ai_results', imageVersions: 'image_versions', imageSelections: 'image_selections', contentVersions: 'content_versions', imageWriteOperations: 'image_write_operations', usageLedger: 'ai_usage_ledger' } as const;
const uuid = (raw: unknown): string | null => typeof raw === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw) ? raw : null;
const integer = (raw: unknown): number | null => typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
const major = (raw: unknown) => { const number = integer(raw); return number !== null && number <= 10000 ? number : 0; };
const canonical = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && b.nlink === 1;
class InspectionIssue extends Error {
  readonly status: DiagnosticAssetStatus;
  constructor(status: DiagnosticAssetStatus) { super(status); this.status = status; }
}
async function safeDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || canonical(await realpath(path)) !== canonical(path)) throw new InspectionIssue('UNSAFE_PATH');
}
async function checkFile(root: string, path: string, expectedSize: number | null, expectedHash: string | null, assets: LocalDiagnosticReport['assets']): Promise<DiagnosticAssetStatus> {
  try {
    await safeDirectory(root); await safeDirectory(join(root, 'assets'));
    const destination = join(root, path), before = await lstat(destination);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || canonical(await realpath(destination)) !== canonical(destination)) return 'UNSAFE_PATH';
    if (before.size > assets.limits.maxFileBytes) { assets.truncated = true; return 'SKIPPED_FILE_LIMIT'; }
    if (expectedSize !== null && before.size !== expectedSize) return 'CONTENT_MISMATCH';
    // Two independent hashes must agree, including previews for which no historical hash exists.
    if (before.size * 2 > assets.limits.maxTotalBytes - assets.bytesRead) { assets.truncated = true; return 'SKIPPED_BYTE_LIMIT'; }
    const file = await open(destination, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!sameFile(before, await file.stat())) return 'CHANGED_DURING_READ';
      await safeDirectory(root); await safeDirectory(join(root, 'assets'));
      const hashes: string[] = [], buffer = Buffer.alloc(Math.min(65536, before.size));
      for (let pass = 0; pass < 2; pass++) {
        const hash = createHash('sha256'); let offset = 0;
        while (offset < before.size) {
          const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
          assets.bytesRead += bytesRead;
          if (!bytesRead) return 'CHANGED_DURING_READ';
          hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
        }
        hashes.push(hash.digest('hex'));
        if (!sameFile(before, await file.stat()) || !sameFile(before, await lstat(destination))) return 'CHANGED_DURING_READ';
      }
      await safeDirectory(root); await safeDirectory(join(root, 'assets'));
      if (canonical(await realpath(destination)) !== canonical(destination) || hashes[0] !== hashes[1]) return 'CHANGED_DURING_READ';
      if (expectedHash !== null && hashes[0] !== expectedHash) return 'CONTENT_MISMATCH';
      return expectedHash === null ? 'READABLE_UNVERIFIED' : 'VERIFIED';
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof InspectionIssue) return error.status;
    const code = (error as { code?: unknown } | null)?.code;
    return code === 'ENOENT' ? 'MISSING' : code === 'ELOOP' ? 'UNSAFE_PATH' : 'IO_ERROR';
  }
}
function databaseError(error: unknown): DiagnosticErrorCode {
  const e = error as { code?: unknown; errcode?: unknown } | null;
  if (e?.code === 'ENOENT') return 'DATABASE_MISSING';
  const code = typeof e?.errcode === 'number' ? e.errcode & 255 : null;
  if (code === 5 || code === 6) return 'DATABASE_BUSY';
  if (code === 11 || code === 26) return 'DATABASE_CORRUPT';
  return 'DATABASE_UNAVAILABLE';
}
function projectedJson(column: string): string {
  // LIMIT bounds rows, and this size guard bounds each JSON parse. Never select arbitrary payloads.
  return `CASE WHEN typeof(record_json)='text' AND length(record_json)<=32768 AND json_valid(record_json) THEN
    CASE WHEN json_type(record_json)='object' AND NOT EXISTS (SELECT 1 FROM json_each(record_json) GROUP BY key COLLATE BINARY HAVING COUNT(*)>1)
      THEN json_extract(record_json,'$.${column}') ELSE NULL END ELSE NULL END`;
}
function recoveryPair(state: ImageWriteState, code: ImageWriteCode): boolean {
  if (state === 'WRITING') return code === 'WRITE_INTENT';
  if (state === 'CLEANED') return code === 'UNCOMMITTED_REMOVED';
  if (state === 'COMMITTED') return code === 'VERSION_COMMITTED';
  return !['WRITE_INTENT', 'UNCOMMITTED_REMOVED', 'VERSION_COMMITTED'].includes(code);
}
async function inspectAssets(db: DatabaseSync, root: string, report: LocalDiagnosticReport): Promise<void> {
  const assets = report.assets;
  async function add(row: Record<string, unknown>, kind: DiagnosticAssetKind, preview: boolean, version: boolean) {
    if (assets.items.length >= assets.limits.maxFiles) { assets.truncated = true; return; }
    const id = uuid(row.id), path = row[preview ? 'previewPath' : 'originalPath'], size = row[preview ? 'previewByteSize' : 'byteSize'], hash = row[preview ? 'previewSha256' : 'sha256'];
    const expectedSize = preview && !version ? null : integer(size), expectedHash = preview && !version ? null : typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) ? hash : undefined;
    const validPath = id && (preview ? path === `assets/${id}.preview.png` : path === `assets/${id}.png` || (!version && path === `assets/${id}.jpg`));
    const valid = validPath && (!version || row.identity === id) && expectedHash !== undefined && (preview && !version || expectedSize !== null && expectedSize > 0);
    const status = valid ? await checkFile(root, path as string, expectedSize, expectedHash!, assets) : 'INVALID_RECORD';
    assets.items.push({ recordId: id, kind, status }); assets.inspected++;
  }
  if (report.counts.assets !== null) {
    const rows = db.prepare(`SELECT CASE WHEN length(id)=36 THEN id ELSE NULL END AS id,
      CASE WHEN length(original_path)<=100 THEN original_path ELSE NULL END AS originalPath,
      CASE WHEN length(preview_path)<=100 THEN preview_path ELSE NULL END AS previewPath,
      CASE WHEN length(sha256)=64 THEN sha256 ELSE NULL END AS sha256,byte_size AS byteSize FROM assets ORDER BY rowid LIMIT 50`).all();
    for (const row of rows) { await add(row, 'ASSET_ORIGINAL', false, false); await add(row, 'ASSET_PREVIEW', true, false); }
  }
  if (report.counts.imageVersions !== null && assets.items.length < assets.limits.maxFiles) {
    const columns = ['id', 'originalPath', 'previewPath', 'byteSize', 'sha256', 'previewByteSize', 'previewSha256'];
    const rows = db.prepare(`SELECT CASE WHEN length(id)=36 THEN id ELSE NULL END AS id,${columns.map(key => `${projectedJson(key)} AS ${key === 'id' ? 'identity' : key}`).join(',')} FROM image_versions ORDER BY rowid LIMIT ?`).all(Math.ceil((assets.limits.maxFiles - assets.items.length) / 2));
    for (const row of rows) { await add(row, 'IMAGE_VERSION_ORIGINAL', false, true); await add(row, 'IMAGE_VERSION_PREVIEW', true, true); }
  }
  assets.truncated ||= assets.total !== null && assets.total > assets.items.length;
}

/** New read-only connection per report; no migration, recovery, cleanup, or persistent connection. */
export async function createLocalDiagnosticReport(directory: string, context: DiagnosticContext): Promise<LocalDiagnosticReport> {
  const report: LocalDiagnosticReport = {
    reportVersion: 1, generatedAt: new Date().toISOString(),
    appVersion: /^(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})(?:-(?:rc|beta|alpha)\.(?:0|[1-9]\d{0,3}))?$/.test(context.appVersion) ? context.appVersion : null,
    schemaVersion: null, runtime: { nodeMajor: major(context.runtime.nodeMajor), electronMajor: major(context.runtime.electronMajor) },
    services: { aiBusy: context.services.aiBusy === true, imageWritesBusy: context.services.imageWritesBusy === true, executionBusy: context.services.executionBusy === true },
    counts: { products: null, assets: null, aiCalls: null, aiResults: null, imageVersions: null, imageSelections: null, contentVersions: null, imageWriteOperations: null, usageLedger: null },
    recovery: { total: null, inspected: 0, invalid: 0, items: [], truncated: false },
    assets: { total: null, inspected: 0, bytesRead: 0, limits: { maxFiles: 100, maxFileBytes: 20971520, maxTotalBytes: 67108864 }, items: [], truncated: false },
    errors: [], truncated: false,
  };
  let db: DatabaseSync | undefined;
  const error = (code: DiagnosticErrorCode) => { if (!report.errors.includes(code)) report.errors.push(code); };
  try {
    await safeDirectory(resolve(directory));
    const databaseFile = join(directory, 'red.sqlite'), databaseStat = await lstat(databaseFile);
    if (!databaseStat.isFile() || databaseStat.isSymbolicLink() || databaseStat.nlink !== 1 || canonical(await realpath(databaseFile)) !== canonical(databaseFile)) { error('UNSAFE_PATH'); return report; }
    db = new DatabaseSync(join(directory, 'red.sqlite'), { readOnly: true });
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=50; PRAGMA query_only=ON; BEGIN');
    report.schemaVersion = integer(db.prepare('PRAGMA user_version').get()?.user_version);
    if (report.schemaVersion === null || report.schemaVersion < 1 || report.schemaVersion > SCHEMA_VERSION) { error('DATABASE_SCHEMA_UNSUPPORTED'); return report; }
    for (const [key, table] of Object.entries(tables)) {
      const definition = db.prepare('SELECT type,sql FROM sqlite_schema WHERE name=?').get(table);
      if (definition?.type !== 'table' || typeof definition.sql !== 'string' || !/^CREATE TABLE\b/i.test(definition.sql)) { error('DATABASE_SCHEMA_UNSUPPORTED'); continue; }
      report.counts[key as keyof typeof tables] = integer(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
    }
    report.recovery.total = report.counts.imageWriteOperations;
    if (report.recovery.total !== null) {
      const rows = db.prepare(`SELECT CASE WHEN length(id)=36 THEN id ELSE NULL END AS id,${projectedJson('id')} AS identity,${projectedJson('state')} AS state,${projectedJson('code')} AS code FROM image_write_operations ORDER BY rowid DESC LIMIT 100`).all();
      report.recovery.inspected = rows.length;
      for (const row of rows) {
        const id = uuid(row.id);
        if (!id || row.identity !== id || !IMAGE_WRITE_STATES.includes(row.state as ImageWriteState) || !IMAGE_WRITE_CODES.includes(row.code as ImageWriteCode)
          || !recoveryPair(row.state as ImageWriteState, row.code as ImageWriteCode)) { report.recovery.invalid++; error('INVALID_RECORD'); continue; }
        report.recovery.items.push({ operationId: id, state: row.state as ImageWriteState, code: row.code as ImageWriteCode });
      }
      report.recovery.truncated = report.recovery.total > rows.length;
    }
    if (report.counts.assets !== null && report.counts.imageVersions !== null) report.assets.total = 2 * (report.counts.assets + report.counts.imageVersions);
    await inspectAssets(db, resolve(directory), report);
  } catch (cause) { error(cause instanceof InspectionIssue ? 'UNSAFE_PATH' : databaseError(cause)); }
  finally {
    try { db?.close(); } catch (cause) { error(databaseError(cause)); }
    report.recovery.truncated ||= report.recovery.total !== null && report.recovery.total > report.recovery.inspected;
    report.assets.truncated ||= report.assets.total !== null && report.assets.total > report.assets.inspected;
    report.truncated = report.recovery.truncated || report.assets.truncated;
  }
  return report;
}
