import { TEXT_REVIEW_POLICY_VERSION } from '../../shared/ai-contracts.ts';
import type { AiCall, AiResult } from '../../shared/ai-contracts.ts';
import type { AdoptReviewedContentInput, ContentVersion } from '../../shared/content-contracts.ts';
import { AiError } from '../ai/errors.ts';
import { candidateFields, suggestionFingerprint } from '../ai/review.ts';
import { date, integer, keys, modelFor, sha256, uuid, validateTextOutput } from '../ai/validation.ts';

export function parseAdoptReviewedContentInput(raw: unknown): AdoptReviewedContentInput {
  try { const o = keys(raw, ['productId', 'productRevision', 'reviewResultId']); return { productId: uuid(o.productId), productRevision: integer(o.productRevision, 1, Number.MAX_SAFE_INTEGER), reviewResultId: uuid(o.reviewResultId) }; }
  catch { throw new AiError('INVALID_INPUT'); }
}
/** Backup/import boundary: accepts the exact public version shape, including a recomputed copy hash. */
export function validateContentVersion(raw: unknown): ContentVersion {
  const o = keys(raw, ['id', 'productId', 'sourceRevision', 'variantId', 'generationResultId', 'reviewResultId', 'suggestionSha256', 'sourceSha256', 'generationModel', 'reviewModel', 'policyVersion', 'createdAt', 'status', 'output']);
  const output = validateTextOutput(o.output), suggestionSha256 = sha256(o.suggestionSha256);
  if (o.status !== 'model-approved' || o.policyVersion !== TEXT_REVIEW_POLICY_VERSION || suggestionFingerprint(output) !== suggestionSha256) throw new AiError('INVALID_CONFIG');
  return { id: uuid(o.id), productId: uuid(o.productId), sourceRevision: integer(o.sourceRevision, 1, Number.MAX_SAFE_INTEGER), variantId: uuid(o.variantId), generationResultId: uuid(o.generationResultId), reviewResultId: uuid(o.reviewResultId), suggestionSha256, sourceSha256: sha256(o.sourceSha256), generationModel: modelFor('deepseek', o.generationModel), reviewModel: modelFor('deepseek-review', o.reviewModel), policyVersion: TEXT_REVIEW_POLICY_VERSION, createdAt: date(o.createdAt), status: 'model-approved', output };
}

/** Validate historical provenance, not freshness: the product or SKU may have changed since adoption. */
export function assertContentHistory(version: ContentVersion, results: ReadonlyMap<string, AiResult>, calls: ReadonlyMap<string, AiCall>): void {
  const generation = results.get(version.generationResultId), review = results.get(version.reviewResultId);
  if (!generation || generation.providerId !== 'deepseek' || generation.output.kind !== 'text'
    || !review || review.providerId !== 'deepseek-review' || review.output.kind !== 'text-review' || review.output.verdict !== 'PASS') throw new AiError('INVALID_CONFIG');
  for (const result of [generation, review]) {
    const call = calls.get(result.callId);
    if (result.productId !== version.productId || result.productRevision !== version.sourceRevision || result.variantId !== version.variantId
      || !call || call.status !== 'SUCCEEDED' || call.providerId !== result.providerId || call.productId !== result.productId
      || call.productRevision !== result.productRevision || call.model !== result.model || call.finishedAt !== result.createdAt) throw new AiError('INVALID_CONFIG');
  }
  if (generation.model !== version.generationModel || review.model !== version.reviewModel
    || generation.sourceSha256 !== version.sourceSha256 || review.output.sourceSha256 !== version.sourceSha256
    || suggestionFingerprint(generation.output) !== version.suggestionSha256 || review.output.suggestionSha256 !== version.suggestionSha256
    || review.output.suggestionId !== generation.id || review.output.policyVersion !== version.policyVersion
    || review.sourceResultIds.length !== 1 || review.sourceResultIds[0] !== generation.id) throw new AiError('INVALID_CONFIG');
  const expectedFields = candidateFields(generation.output), checks = review.output.checks;
  if (checks.length !== expectedFields.length || expectedFields.some(field => !checks.some(check => check.field === field))) throw new AiError('INVALID_CONFIG');
}
