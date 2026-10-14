import type { DatabaseSync } from 'node:sqlite';
import { UserFacingError } from '../../shared/errors.ts';
import { readErrorEvidence } from '../error-evidence.ts';
import { appendAuditEvent } from '../storage/audit.ts';
import { evidenceId, evidenceTime, validateRunEvidence } from './run-evidence.ts';

/** Restore preserves safe diagnostics by original ID; it never creates business objects or permissions. */
export function retainRunEvidence(current: DatabaseSync, snapshot: DatabaseSync): void {
  const invalid = (): never => { throw new UserFacingError('RUN_EVIDENCE_RESTORE_CONFLICT'); };
  for (const row of current.prepare("SELECT id,product_id,action,detail_json,created_at FROM audit_events WHERE action IN ('run.evidence','operation.failed') ORDER BY rowid").iterate()) {
    if (!evidenceId(row.id) || !evidenceTime(row.created_at) || typeof row.detail_json !== 'string' || row.detail_json.length > 8192) { if (row.action === 'run.evidence') invalid(); continue; }
    let detail;
    try { detail = row.action === 'run.evidence' ? validateRunEvidence(JSON.parse(String(row.detail_json))) : readErrorEvidence(JSON.parse(String(row.detail_json))); }
    catch { invalid(); }
    if (!detail) continue;
    const productId = row.product_id;
    if (productId !== null && !evidenceId(productId) || detail.itemKey && productId && detail.itemKey.slice(0,36) !== productId
      || 'productId' in detail && detail.productId && productId && detail.productId !== productId) invalid();
    if (detail.draftId && productId) for (const db of [current,snapshot]) {
      const draft = db.prepare("SELECT product_id FROM listing_drafts WHERE id=?").get(detail.draftId);
      if (draft && draft.product_id !== productId) invalid();
    }
    const safeProduct = productId && snapshot.prepare('SELECT id FROM products WHERE id=?').get(productId) ? String(productId) : null;
    const previous = snapshot.prepare('SELECT product_id,action,detail_json,created_at FROM audit_events WHERE id=?').get(row.id);
    if (previous) {
      if (previous.action !== row.action || previous.detail_json !== row.detail_json || previous.created_at !== row.created_at || previous.product_id !== safeProduct) invalid();
      continue;
    }
    appendAuditEvent(snapshot, String(row.id), safeProduct, String(row.action), row.action === 'run.evidence' ? '运行阶段证据' : '步骤失败（脱敏诊断）', String(row.detail_json), String(row.created_at));
  }
}
