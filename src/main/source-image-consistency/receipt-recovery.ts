import type { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import type { AiCall, AiResult } from '../../shared/ai-contracts.ts';
import { verifiedRecoveryReceipt, assertReceiptRecovery } from '../ai/receipt-recovery.ts';
import { resultHasOwner } from '../ai/result-owner.ts';
import { AiError } from '../ai/errors.ts';
import { listingFingerprint } from '../json-fingerprint.ts';
import { normalizeSourceObservations } from './comparison.ts';
import { sourceReferenceAliasesForCall } from './reference-aliases.ts';

/** Exact original private receipt, never a pure marker or a newly built UI map. */
export function recoverableSourceReceipt(db: DatabaseSync, directory: string | undefined, call: AiCall) {
  if (!call.sourceConsistencyContext || call.status !== 'FAILED' || !call.requestScope
    || call.requestScope.operation !== 'source-observation' || call.requestScope.productId !== call.productId
    || call.requestScope.variantId !== call.sourceConsistencyContext.variantId) return null;
  const aliases = sourceReferenceAliasesForCall(call);
  const file = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  const root = directory ?? (typeof file === 'string' && file ? dirname(file) : undefined);
  if (!root) return null;
  const saved = verifiedRecoveryReceipt(db, root, call);
  if (!saved) return null;
  const body = saved.capture.body as any, choice = body?.choices?.[0], message = choice?.message;
  if (!Array.isArray(body?.choices) || body.choices.length !== 1 || choice.finish_reason !== 'stop'
    || !message || message.refusal || message.function_call !== undefined
    || message.tool_calls !== undefined && (!Array.isArray(message.tool_calls) || message.tool_calls.length)
    || typeof message.content !== 'string') return null;
  try {
    const output = normalizeSourceObservations(JSON.parse(message.content), call.sourceConsistencyContext, aliases);
    return { saved, output, directory: root };
  } catch { return null; }
}

/** Structural staged-database validation is not evidence that an observation is usable. */
export function assertSourceRecoveryOwner(result: AiResult, call: AiCall | undefined): void {
  if (!result.providerReceiptRecovery || result.output.kind !== 'source-image-consistency') return;
  if (!call || result.providerReceiptRecovery.version !== 1 || !resultHasOwner(result, call)
    || call.requestScope?.operation !== 'source-observation' || call.requestScope.variantId !== call.sourceConsistencyContext?.variantId
    || listingFingerprint(result.sourceConsistencyContext) !== listingFingerprint(call.sourceConsistencyContext)) throw new AiError('INVALID_CONFIG');
  sourceReferenceAliasesForCall(call);
}

/** Read consumers must prove the canonical output against the original raw too. */
export function assertSourceReceiptRecovery(db: DatabaseSync, directory: string | undefined, result: AiResult, call: AiCall | undefined): void {
  if (!result.providerReceiptRecovery || result.output.kind !== 'source-image-consistency') return;
  assertSourceRecoveryOwner(result, call);
  if (!call) throw new AiError('INVALID_CONFIG');
  const recovered = recoverableSourceReceipt(db, directory, call);
  if (!recovered || listingFingerprint(recovered.output) !== listingFingerprint(result.output)) throw new AiError('INVALID_CONFIG');
  assertReceiptRecovery(db, recovered.directory, result, call);
}
