import type { DatabaseSync } from 'node:sqlite';
import { UserFacingError } from '../../shared/errors.ts';
import type { AiUsageReport,AiUsageReportRow } from '../../shared/ai-purpose-contracts.ts';

/** UTC-day ledger report. Provider-reported USD is not a complete account invoice. */
export function readAiUsageReport(db:DatabaseSync,raw:unknown):AiUsageReport{
  const input=raw as {from:string;to:string};
  const day=(value:unknown)=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
  if(!input||Object.keys(input).sort().join()!=='from,to'||!day(input.from)||!day(input.to)||input.from>input.to)throw new UserFacingError('用量日期范围无效');
  const calls=new Map<string,any>(db.prepare("SELECT record_json FROM ai_calls WHERE substr(json_extract(record_json,'$.startedAt'),1,10) BETWEEN ? AND ?").all(input.from,input.to).map(row=>{const r=JSON.parse(String(row.record_json));return[r.id,r];}));
  const costs=new Map<string,number>(),reportedTokens=new Map<string,number>();for(const row of db.prepare('SELECT record_json FROM ai_provider_receipts ORDER BY rowid').iterate()){
    const receipt=JSON.parse(String(row.record_json));if(Number.isSafeInteger(receipt.reportedTokens)&&receipt.reportedTokens>=0)reportedTokens.set(receipt.callId,receipt.reportedTokens);if(typeof receipt.costUsd==='number'&&Number.isFinite(receipt.costUsd)&&receipt.costUsd>=0)costs.set(receipt.callId,receipt.costUsd);
  }
  const entries:any[]=db.prepare("SELECT record_json FROM ai_usage_ledger WHERE substr(json_extract(record_json,'$.startedAt'),1,10) BETWEEN ? AND ?").all(input.from,input.to).map(row=>JSON.parse(String(row.record_json)));
  const known=new Set(entries.map(e=>e.id));
  for(const row of db.prepare("SELECT record_json FROM ai_image_requests WHERE substr(json_extract(record_json,'$.createdAt'),1,10) BETWEEN ? AND ?").iterate(input.from,input.to)){
    const r=JSON.parse(String(row.record_json));if(known.has(r.id))continue;entries.push({...r,startedAt:r.createdAt,providerId:'openrouter',purposeId:'image_generation'});
  }
  const grouped=new Map<string,AiUsageReportRow>();
  for(const entry of entries){
    const call=calls.get(entry.id),purposeId=call?.purposeSnapshot?.purposeId??entry.purposeId??'legacy',model=call?.model??entry.model??'历史型号未知',gateway=String(entry.providerId).startsWith('openrouter')?'openrouter':String(entry.providerId).startsWith('deepseek')?'deepseek':'aliyun',date=String(entry.startedAt).slice(0,10);
    const key=JSON.stringify([date,purposeId,gateway,model]),row=grouped.get(key)??{date,purposeId,gateway,model,calls:0,reportedTokens:0,reportedCostUsd:0,unknownCostCalls:0,totalCostUsd:null};
    row.calls++;row.reportedTokens+=reportedTokens.get(entry.id)??(entry.state==='REPORTED'?(entry.usage.promptTokens??0)+(entry.usage.completionTokens??0):0);
    if(costs.has(entry.id))row.reportedCostUsd+=costs.get(entry.id)!;else row.unknownCostCalls++;
    row.totalCostUsd=row.unknownCostCalls?null:row.reportedCostUsd;grouped.set(key,row);
  }
  const rows=[...grouped.values()].sort((a,b)=>b.date.localeCompare(a.date)||a.purposeId.localeCompare(b.purposeId));
  const count=rows.reduce((n,r)=>n+r.calls,0),reportedCostUsd=rows.reduce((n,r)=>n+r.reportedCostUsd,0),unknownCostCalls=rows.reduce((n,r)=>n+r.unknownCostCalls,0);
  return{from:input.from,to:input.to,timeZone:'UTC',calls:count,reportedCostUsd,unknownCostCalls,totalCostUsd:unknownCostCalls?null:reportedCostUsd,rows};
}
