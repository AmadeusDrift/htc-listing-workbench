import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AiCall } from '../../shared/ai-contracts.ts';
import { AiError } from './errors.ts';
import { taskAiContext } from './batch/task-context.ts';
import { confirmedForbiddenRejection } from './receipts.ts';
import { appendAuditEvent } from '../storage/audit.ts';

const ACTION='ai.forbidden.manual-retry';
const fail=(message='历史403未满足安全重试条件；本次未发送新请求，请核对原记录'):never=>{const error=new AiError('ROUTING_FORBIDDEN');error.message=message;throw error;};
function claimId(scopeKey:string):string {
 if(!scopeKey||scopeKey.length>1000)fail();
 const hex=createHash('sha256').update(ACTION+':'+scopeKey).digest('hex');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
}
export function isConfirmedForbiddenRetryCall(db:DatabaseSync,callId:string):boolean {
 return !!db.prepare("SELECT 1 FROM audit_events WHERE action=? AND json_extract(detail_json,'$.retryCallId')=?").get(ACTION,callId);
}
function used(db:DatabaseSync,prior:AiCall,scopeKey:string):boolean {
 return !!db.prepare("SELECT 1 FROM audit_events WHERE action=? AND (id=? OR json_extract(detail_json,'$.retryCallId')=? OR json_extract(detail_json,'$.priorCallId')=?)").get(ACTION,claimId(scopeKey),prior.id,prior.id);
}
/** No mutation: only an explicit, live task continuation can authorize the one retry. */
export function canRetryConfirmedForbidden(db:DatabaseSync,prior:AiCall,scopeKey:string):boolean {
 const scope=taskAiContext.getStore();
 return !!scope?.explicitContinueAt&&Number.isFinite(Date.parse(scope.explicitContinueAt))&&Date.parse(scope.explicitContinueAt)>Date.parse(prior.finishedAt??prior.startedAt)&&scope.authorize()&&confirmedForbiddenRejection(db,prior)&&!used(db,prior,scopeKey);
}
export function assertConfirmedForbiddenRetry(db:DatabaseSync,prior:AiCall,scopeKey:string):void {
 if(used(db,prior,scopeKey))fail('已使用一次手动403重试；本次未发送新请求，请核对上次重试结果与配置');
 if(!canRetryConfirmedForbidden(db,prior,scopeKey))fail('历史403失败尚未获本次手动继续授权或原始回执无法确认；本次未发送新请求');
}
/** Caller MUST invoke inside the same usage/call reservation transaction; no autonomous grant. */
export function claimConfirmedForbiddenRetry(db:DatabaseSync,prior:AiCall,retry:Pick<AiCall,'id'|'productId'|'startedAt'>,scopeKey:string):void {
 assertConfirmedForbiddenRetry(db,prior,scopeKey);
 if(retry.id===prior.id||retry.productId!==prior.productId||!db.prepare('SELECT 1 FROM ai_calls WHERE id=?').get(retry.id)||!db.prepare('SELECT 1 FROM ai_usage_ledger WHERE id=?').get(retry.id))fail();
 const scope=taskAiContext.getStore()!;
 appendAuditEvent(db,claimId(scopeKey),prior.productId,ACTION,'明确403拒绝后手动重试一次',JSON.stringify({version:1,scopeKey,priorCallId:prior.id,retryCallId:retry.id,receiptId:prior.providerReceiptId,continuedAt:scope.explicitContinueAt}),retry.startedAt);
}
/** Safety tombstones survive restoring an older backup, even if the new call is absent there. */
export function retainConfirmedForbiddenRetries(current:DatabaseSync,snapshot:DatabaseSync):void {
 for(const row of current.prepare('SELECT * FROM audit_events WHERE action=?').all(ACTION)){
  const detail=JSON.parse(String(row.detail_json));
  if(detail.version!==1||typeof detail.scopeKey!=='string'||claimId(detail.scopeKey)!==row.id||Object.keys(detail).sort().join()!=='continuedAt,priorCallId,receiptId,retryCallId,scopeKey,version'||!['priorCallId','retryCallId'].every(key=>typeof detail[key]==='string'&&/^[a-f0-9-]{36}$/.test(detail[key]))||typeof detail.receiptId!=='string'||!/^[a-f0-9]{64}$/.test(detail.receiptId)||!Number.isFinite(Date.parse(detail.continuedAt)))fail();
  const prior=snapshot.prepare('SELECT * FROM audit_events WHERE id=?').get(row.id);
  if(prior){if(prior.action!==row.action||prior.detail_json!==row.detail_json||prior.created_at!==row.created_at)fail();continue;}
  appendAuditEvent(snapshot,String(row.id),null,ACTION,String(row.summary),String(row.detail_json),String(row.created_at));
 }
}
