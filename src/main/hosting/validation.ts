import { HOSTING_ERROR_CODES, HOSTING_PROFILE_IDS } from '../../shared/hosting-contracts.ts';
import type { HostedAsset, HostingProfile, HostingProfileId, HostingUploadInput, HostingRoute } from '../../shared/hosting-contracts.ts';
import { HostingError } from './errors.ts';
import { validatePublicUrl } from './public-probe.ts';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const PROFILE_NAMES = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
function invalid(): never { throw new HostingError('INVALID_CONFIG'); }
export function objectKeys(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid();
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).length !== keys.length || Object.keys(o).some(key => !keys.includes(key))) invalid();
  return o;
}
function optionalKeys(raw: unknown, keys: readonly string[], optional: readonly string[]): Record<string, unknown> {
  const value = raw as Record<string, unknown>;
  return objectKeys(raw, [...keys, ...optional.filter(key => value && Object.hasOwn(value, key))]);
}
export function parseHostingRoute(raw: unknown): HostingRoute {
  if (raw && typeof raw === 'object' && 'mode' in raw && raw.mode === 'direct') { objectKeys(raw, ['mode']); return { mode: 'direct' }; }
  const o = objectKeys(raw, ['mode', 'host', 'port', 'dns']);
  // Local SOCKS5 only, with no proxy credentials in renderer or persisted profiles.
  if (o.mode !== 'socks5' || o.host !== '127.0.0.1' || o.dns !== 'proxy') invalid();
  return { mode: 'socks5', host: '127.0.0.1', port: integer(o.port, 1, 65535), dns: 'proxy' };
}
export function profileId(value: unknown): HostingProfileId {
  if (typeof value !== 'string' || !HOSTING_PROFILE_IDS.includes(value as HostingProfileId)) invalid();
  return value as HostingProfileId;
}
export function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) throw new HostingError('INVALID_INPUT'); return value; }
function integer(value: unknown, min: number, max: number): number { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) invalid(); return Number(value); }
function flag(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function text(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.length) || /[\x00-\x1f\x7f]/.test(value)) invalid(); return value;
}
function host(value: unknown, allowEmpty: boolean): string {
  const s = text(value, 253, allowEmpty);
  if (s && (!/^[a-zA-Z0-9.-]+$/.test(s) || s.startsWith('.') || s.endsWith('.') || s.includes('..'))) invalid();
  return s;
}
export function remoteRoot(value: unknown): string {
  const s = text(value, 400);
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/.test(s)) invalid();
  return s === '/' ? '/' : s.replace(/\/$/, '');
}
function baseUrl(value: unknown): string {
  try {
    const url = validatePublicUrl(text(value, 2000));
    if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/.test(url.pathname)) invalid();
    url.pathname = url.pathname.replace(/\/?$/, '/'); return url.href;
  } catch { return invalid(); }
}
export interface HostingCredentials { username: string; password: string }
export interface ProfileImport extends HostingCredentials { id: HostingProfileId; host: string; port: number; secure: boolean; remoteRoot: string; publicBaseUrl: string }
export function parseProfileImport(raw: unknown): ProfileImport {
  const o = objectKeys(raw, ['id', 'host', 'port', 'secure', 'username', 'password', 'remoteRoot', 'publicBaseUrl']);
  const parsed = { id: profileId(o.id), host: host(o.host, false), port: integer(o.port, 1, 65535), secure: flag(o.secure), username: text(o.username, 1024), password: text(o.password, 4096), remoteRoot: remoteRoot(o.remoteRoot), publicBaseUrl: baseUrl(o.publicBaseUrl) };
  const editablePublicValues = [parsed.host, parsed.remoteRoot, parsed.publicBaseUrl];
  // Legacy usernames are the fixed Alpha–Epsilon labels; those labels are not user-controlled output.
  if (editablePublicValues.some(value => value.includes(parsed.username)) || [...editablePublicValues, parsed.id, PROFILE_NAMES[HOSTING_PROFILE_IDS.indexOf(parsed.id)]].some(value => value.includes(parsed.password))) invalid();
  return parsed;
}
export function validatePersistedProfile(raw: unknown): HostingProfile {
  const o = optionalKeys(raw, ['id', 'name', 'host', 'port', 'secure', 'remoteRoot', 'publicBaseUrl', 'enabled', 'configured', 'generation'], ['route']);
  const id = profileId(o.id), name = PROFILE_NAMES[HOSTING_PROFILE_IDS.indexOf(id)];
  if (o.name !== name) invalid();
  return { id, name, host: host(o.host, true), port: integer(o.port, 1, 65535), secure: flag(o.secure), remoteRoot: remoteRoot(o.remoteRoot), publicBaseUrl: baseUrl(o.publicBaseUrl), enabled: flag(o.enabled), configured: flag(o.configured), generation: integer(o.generation, 0, Number.MAX_SAFE_INTEGER - 1), ...(Object.hasOwn(o, 'route') ? { route: parseHostingRoute(o.route) } : {}) };
}
export function parseUploadInput(raw: unknown): HostingUploadInput {
  const o = optionalKeys(raw, ['assetId', 'profileId', 'generation', 'batchId'], ['route']);
  return { assetId: uuid(o.assetId), profileId: profileId(o.profileId), generation: integer(o.generation, 1, Number.MAX_SAFE_INTEGER - 1), batchId: uuid(o.batchId), ...(Object.hasOwn(o, 'route') ? { route: parseHostingRoute(o.route) } : {}) };
}
function date(value: unknown): string { const s = text(value, 30); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s) || !Number.isFinite(Date.parse(s))) invalid(); return s; }
function errorCode(value: unknown): HostedAsset['errorCode'] { if (value === null) return null; if (!HOSTING_ERROR_CODES.includes(value as never)) invalid(); return value as HostedAsset['errorCode']; }
export function validatePersistedUpload(raw: unknown): HostedAsset {
  const o = optionalKeys(raw, ['id', 'assetId', 'profileId', 'batchId', 'generation', 'sha256', 'byteSize', 'mimeType', 'remotePath', 'publicUrl', 'status', 'attempts', 'history', 'errorCode', 'createdAt', 'updatedAt'], ['route']);
  const id = uuid(o.id), assetId = uuid(o.assetId), batchId = uuid(o.batchId), sha256 = text(o.sha256, 64);
  if (!HASH.test(sha256) || !['image/png', 'image/jpeg'].includes(String(o.mimeType)) || !['PENDING', 'UPLOADING', 'VERIFYING', 'AVAILABLE', 'FAILED', 'CANCELLED'].includes(String(o.status))) invalid();
  const path = text(o.remotePath, 800), ext = o.mimeType === 'image/png' ? 'png' : 'jpg';
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(path) || !path.endsWith(`/${batchId}/${assetId}-${sha256.slice(0, 16)}.${ext}`) || !/\/\d{8}\//.test(path)) invalid();
  let publicUrl: URL; try { publicUrl = validatePublicUrl(text(o.publicUrl, 3000)); } catch { return invalid(); }
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(publicUrl.pathname) || !publicUrl.pathname.endsWith(path.slice(path.lastIndexOf(`/${batchId}/`)))) invalid();
  const attempts = integer(o.attempts, 0, 100000);
  if (!Array.isArray(o.history) || o.history.length > attempts || o.history.length > 100000) invalid();
  const history = o.history.map(entry => {
    const a = optionalKeys(entry, ['attempt', 'status', 'errorCode', 'startedAt', 'finishedAt'], ['stage', 'delivery']);
    if (a.stage !== undefined && !['connect','directory','size','upload','public-get'].includes(String(a.stage)) || a.delivery !== undefined && !['not-sent','unknown','confirmed'].includes(String(a.delivery))) invalid();
    if (!['AVAILABLE', 'FAILED', 'CANCELLED'].includes(String(a.status))) invalid();
    return { attempt: integer(a.attempt, 1, attempts), status: a.status as 'AVAILABLE' | 'FAILED' | 'CANCELLED', errorCode: errorCode(a.errorCode), startedAt: date(a.startedAt), finishedAt: date(a.finishedAt), ...(a.stage !== undefined ? { stage: a.stage as NonNullable<HostedAsset['history'][number]['stage']> } : {}), ...(a.delivery !== undefined ? { delivery: a.delivery as NonNullable<HostedAsset['history'][number]['delivery']> } : {}) };
  });
  if (new Set(history.map(h => h.attempt)).size !== history.length) invalid();
  return { id, assetId, profileId: profileId(o.profileId), batchId, generation: integer(o.generation, 1, Number.MAX_SAFE_INTEGER - 1), sha256, byteSize: integer(o.byteSize, 1, MAX_IMAGE_BYTES), mimeType: o.mimeType as HostedAsset['mimeType'], remotePath: path, publicUrl: publicUrl.href, status: o.status as HostedAsset['status'], attempts, history, errorCode: errorCode(o.errorCode), createdAt: date(o.createdAt), updatedAt: date(o.updatedAt), ...(Object.hasOwn(o, 'route') ? { route: parseHostingRoute(o.route) } : {}) };
}
