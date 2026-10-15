import type {DatabaseSync} from 'node:sqlite';
import type {AutomaticListingTask,AutomaticRoundSummary} from '../../shared/automatic-listing-contracts.ts';

/** Read on demand only. No reservation, policy, receipt or lifetime amount is changed. */
export function readRoundSpend(db:DatabaseSync,task:AutomaticListingTask,round:AutomaticRoundSummary):NonNullable<AutomaticRoundSummary['fees']>{
 const calls=new Set<string>();
 for(const row of db.prepare("SELECT DISTINCT json_extract(detail_json,'$.callId') id FROM audit_events WHERE action='run.evidence' AND created_at>=? AND json_extract(detail_json,'$.taskId')=? AND json_type(detail_json,'$.callId')='text'").all(round.startedAt,task.id))calls.add(String(row.id));
 // Image intents have durable exact draft/SKU ownership. Never infer from product alone.
 const drafts=new Map(task.items.filter(item=>item.draftId).map(item=>[item.draftId!,item]));
 for(const row of db.prepare("SELECT id,record_json FROM ai_image_requests WHERE json_extract(record_json,'$.createdAt')>=? AND json_extract(record_json,'$.requestScope.draftId') IN (SELECT value FROM json_each(?))").all(round.startedAt,JSON.stringify([...drafts.keys()]))){
  const intent=JSON.parse(String(row.record_json)),scope=intent.requestScope,item=scope?drafts.get(scope.draftId):undefined;
  if(intent.id===row.id&&item&&scope.productId===item.productId&&scope.sku===item.sku&&scope.targetId===task.targetId&&scope.marketplaceId===task.marketplaceId)calls.add(String(row.id));
 }
 let reportedUsdMicros=0,pendingCalls=0,unknownCostCalls=0;
 for(const id of calls){
  const saved=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(id)??db.prepare('SELECT record_json FROM ai_image_requests WHERE id=?').get(id);
  if(!saved)continue;const call=JSON.parse(String(saved.record_json)),startedAt=call.startedAt??call.createdAt;
  if(call.id!==id||typeof startedAt!=='string'||startedAt<round.startedAt)continue;
  const receipts=db.prepare("SELECT id,record_json FROM ai_provider_receipts WHERE json_extract(record_json,'$.callId')=?").all(id);
  let amount:number|null=null;
  for(const receipt of receipts){const value=JSON.parse(String(receipt.record_json));if(value.id!==receipt.id||value.callId!==id)continue;const cost=value.costUsd;
   if(typeof cost==='number'&&Number.isFinite(cost)&&cost>=0){const micros=Math.round(cost*1_000_000);if(Number.isSafeInteger(micros))amount=Math.max(amount??0,micros);}
  }
  if(amount===null)unknownCostCalls++;else reportedUsdMicros+=amount;
  if(call.status==='RUNNING'||call.status==='PENDING'||!receipts.length)pendingCalls++;
 }
 return {reportedUsdMicros,pendingCalls,unknownCostCalls,coverage:'EXPLICIT_TASK_AND_DRAFT_LINKS'};
}
