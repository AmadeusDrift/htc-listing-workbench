import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ContentVersion } from '../../shared/content-contracts.ts';
import { AiError, safeError } from '../ai/errors.ts';
import type { AiService } from '../ai/service.ts';
import { uuid } from '../ai/validation.ts';
import { openDatabase } from '../database.ts';
import { RecordReader } from '../record-query.ts';
import type { WorkspaceStore } from '../store.ts';
import { parseAdoptReviewedContentInput, validateContentVersion } from './validation.ts';

/** Immutable, local content versions. Construction and adoption never call a provider or write source data. */
export class ReviewedContentService {
  private db: DatabaseSync;
  private records: RecordReader;
  private store: WorkspaceStore;
  private ai: AiService;
  private closed = false;
  constructor(directory: string, store: WorkspaceStore, ai: AiService) { this.db = openDatabase(directory); this.records = new RecordReader(this.db); this.store = store; this.ai = ai; }
  private ensureOpen(): void { if (this.closed) throw new AiError('SERVICE_CLOSED'); }
  list(rawProductId: string): ContentVersion[] {
    this.ensureOpen(); return this.records.list('content_versions', { productId: uuid(rawProductId) }, validateContentVersion);
  }
  queryVersions(raw: unknown) { this.ensureOpen(); return this.records.query('content_versions', raw, validateContentVersion); }
  async adopt(raw: unknown): Promise<ContentVersion> {
    this.ensureOpen(); const input = parseAdoptReviewedContentInput(raw);
    const source = await this.ai.reviewedContent(input); this.ensureOpen();
    // No await inside the transaction: freshness, idempotence and insert observe one database state.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      try { if (this.store.getProduct(input.productId).revision !== input.productRevision) throw new Error(); } catch { throw new AiError('SOURCE_CHANGED'); }
      source.assertFresh();
      const previous = this.list(input.productId).find(row => row.reviewResultId === source.review.id);
      if (previous) {
        if (previous.sourceRevision !== input.productRevision || previous.variantId !== source.suggestion.variantId || previous.generationResultId !== source.suggestion.id || previous.suggestionSha256 !== source.review.output.suggestionSha256 || previous.sourceSha256 !== source.review.output.sourceSha256 || previous.generationModel !== source.suggestion.model || previous.reviewModel !== source.review.model || previous.policyVersion !== source.review.output.policyVersion) throw new AiError('SOURCE_CHANGED');
        this.db.exec('COMMIT'); return previous;
      }
      const result = validateContentVersion({ id: randomUUID(), productId: input.productId, sourceRevision: input.productRevision, variantId: source.suggestion.variantId, generationResultId: source.suggestion.id, reviewResultId: source.review.id, suggestionSha256: source.review.output.suggestionSha256, sourceSha256: source.review.output.sourceSha256, generationModel: source.suggestion.model, reviewModel: source.review.model, policyVersion: source.review.output.policyVersion, createdAt: new Date().toISOString(), status: 'model-approved', output: source.suggestion.output });
      this.db.prepare('INSERT INTO content_versions(id,record_json) VALUES(?,?)').run(result.id, JSON.stringify(result));
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw safeError(error); }
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}
