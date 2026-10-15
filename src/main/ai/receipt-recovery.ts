import type { DatabaseSync } from 'node:sqlite';
import type { AiCall,AiResult } from '../../shared/ai-contracts.ts';
import { readCallReceiptSync } from './receipts.ts';
import { openRouterFailure } from './adapters/openrouter-http.ts';
import { resultHasOwner } from './result-owner.ts';
import { listingFingerprint } from '../json-fingerprint.ts';
import { AiError } from './errors.ts';

/** Original bytes, file identity and metadata are verified by the M07 reader.
 * A marker alone cannot make a provider error or damaged receipt recoverable. */
export function verifiedRecoveryReceipt(db:DatabaseSync,directory:string,call:AiCall) {
  if(call.status!=='FAILED'||!call.requestScope||!call.requestFingerprint)return null;
  const saved=readCallReceiptSync(db,directory,call);
  if(!saved||saved.record.status<200||saved.record.status>=300||openRouterFailure(saved.record.status,saved.capture.body))return null;
  const captured=saved.capture as unknown as {purpose?:unknown;body:any};
  if(listingFingerprint(captured.purpose??null)!==listingFingerprint(call.purposeSnapshot??null)||!captured.body||typeof captured.body!=='object'||captured.body.encoding==='raw-utf8-invalid/v1')return null;
  return saved;
}
/** Shared by runtime reads and the backup's current/staged artifact root. */
export function assertReceiptRecovery(db:DatabaseSync,directory:string,result:AiResult,call:AiCall|undefined):void {
  if(!result.providerReceiptRecovery)return;
  if(!call||!resultHasOwner(result,call))throw new AiError('INVALID_CONFIG');
  const saved=verifiedRecoveryReceipt(db,directory,call);
  if(!saved||saved.record.id!==result.providerReceiptRecovery.receiptId)throw new AiError('INVALID_CONFIG');
}
