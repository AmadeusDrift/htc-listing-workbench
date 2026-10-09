import type { ImageSelection, ImageVersion } from '../../shared/image-version-contracts.ts';
import { boundedText, integer, keys, uuid } from '../ai/validation.ts';
import { AiError } from '../ai/errors.ts';
export function imageHash(raw: unknown): string { if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw)) throw new AiError('INVALID_INPUT'); return raw; }
function date(raw: unknown): string { const text = boundedText(raw, 24); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) throw new AiError('INVALID_INPUT'); return text; }
export function validateImageVersion(raw: unknown): ImageVersion {
  const o = keys(raw, ['id','productId','productRevision','sourceAssetId','sourceSha256','resultId','version','width','height','byteSize','sha256','originalPath','previewPath','previewSha256','previewByteSize','createdAt','reviewState','checks']);
  const id = uuid(o.id), width = integer(o.width, 256, 3000), height = integer(o.height, 256, 3000), checks = keys(o.checks, ['transparentPixels','subjectPixels']);
  const transparentPixels = integer(checks.transparentPixels, 1, width * height - 1), subjectPixels = integer(checks.subjectPixels, 1, width * height - 1);
  if (transparentPixels + subjectPixels !== width * height || o.originalPath !== `assets/${id}.png` || o.previewPath !== `assets/${id}.preview.png` || o.reviewState !== 'unreviewed') throw new AiError('INVALID_INPUT');
  return { id, productId: uuid(o.productId), productRevision: integer(o.productRevision, 1, Number.MAX_SAFE_INTEGER), sourceAssetId: uuid(o.sourceAssetId), sourceSha256: imageHash(o.sourceSha256), resultId: uuid(o.resultId), version: integer(o.version, 1, Number.MAX_SAFE_INTEGER), width, height, byteSize: integer(o.byteSize, 1, 20 * 1024 * 1024), sha256: imageHash(o.sha256), originalPath: o.originalPath, previewPath: o.previewPath, previewSha256: imageHash(o.previewSha256), previewByteSize: integer(o.previewByteSize, 1, 4 * 1024 * 1024), createdAt: date(o.createdAt), reviewState: 'unreviewed', checks: { transparentPixels, subjectPixels } };
}
export function validateImageSelection(raw: unknown): ImageSelection {
  const o = keys(raw, ['id','productId','sourceAssetId','sourceSha256','versionId','selectedAt','reviewState']);
  if (o.reviewState !== 'human-selected') throw new AiError('INVALID_INPUT');
  return { id: uuid(o.id), productId: uuid(o.productId), sourceAssetId: uuid(o.sourceAssetId), sourceSha256: imageHash(o.sourceSha256), versionId: o.versionId === null ? null : uuid(o.versionId), selectedAt: date(o.selectedAt), reviewState: 'human-selected' };
}
