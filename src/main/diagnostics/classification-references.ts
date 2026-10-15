import type {DatabaseSync} from 'node:sqlite';
import {UserFacingError} from '../../shared/errors.ts';
import {evidenceId,evidenceTime} from './run-evidence.ts';
import {listingFingerprint} from '../json-fingerprint.ts';
import {categoryOperationId} from '../ai/category-context.ts';

export interface ClassificationItem {key:string;productId:string;sku:string;productRevision:unknown;classification:unknown}
export interface ClassificationReference {item:ClassificationItem;resultId:string;callId:string;operationId:string|null}
function invalid():never{throw new UserFacingError('RUN_REPORT_INVALID_RECORD');}
const p=(path:string,column:string)=>`CASE WHEN json_valid(${column}) THEN json_extract(${column},'$.${path}') END`;
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function recoveryOwner(row:Record<string,unknown>):boolean{
  if(row.recovery===null)return row.status==='SUCCEEDED'&&row.finishedAt===row.createdAt;
  // Same immutable ownership fields as M07 receipt recovery. This report only
  // projects saved metadata; receipt body integrity remains explicitly unverified.
  if(row.status!=='FAILED'||String(row.finishedAt)>String(row.createdAt)||typeof row.recovery!=='string'||row.recovery.length>4096||typeof row.ownerScope!=='string'||row.ownerScope.length>4096)return false;
  try{const r=JSON.parse(row.recovery),scope=JSON.parse(row.ownerScope);
    return r&&[1,2].includes(r.version)&&Object.keys(r).sort().join()===(r.version===1?'receiptId,recoveredAt,requestFingerprint,scopeSha256,version':'receiptId,receiptSha256,recoveredAt,requestFingerprint,scopeSha256,version')
      &&sha(r.receiptId)&&sha(r.requestFingerprint)&&sha(r.scopeSha256)&&r.recoveredAt===row.createdAt&&r.requestFingerprint===row.requestFingerprint&&listingFingerprint(scope)===r.scopeSha256
      &&(r.version===1?row.providerReceiptId===r.receiptId:row.providerReceiptId===null&&sha(r.receiptSha256));
  }catch{return false;}
}
/** Read only the saved domain references and their exact result -> paid call FK.
 * Never associate by product/time, and never adopt other results of that call.
 * Scalar projections deliberately exclude provider text, URLs and credentials.
 */
export function classificationReferences(db:DatabaseSync,items:ClassificationItem[]):ClassificationReference[]{
  const references:ClassificationReference[]=[];
  for(const item of items){
    if(item.classification===null)continue;
    if(typeof item.classification!=='string'||item.classification.length>32768)invalid();
    let c;try{c=JSON.parse(item.classification);}catch{invalid();}
    if(!c||typeof c!=='object'||Array.isArray(c)||!Array.isArray(c.decisionIds)||![2,3].includes(c.decisionIds.length)
      ||new Set(c.decisionIds).size!==c.decisionIds.length||!c.decisionIds.every(evidenceId)||typeof c.judged!=='boolean'||c.judged!==(c.decisionIds.length===3)
      ||typeof c.productType!=='string'||!/^[A-Z0-9_]{1,100}$/.test(c.productType)||!Array.isArray(c.candidateTypes)||!c.candidateTypes.includes(c.productType)
      ||!evidenceTime(c.classifiedAt)||!Number.isSafeInteger(item.productRevision)||Number(item.productRevision)<1)invalid();
    const phases=c.judged?['keywords','select','judge']:['keywords','select'];
    for(const [index,resultId] of (c.decisionIds as string[]).entries()){
      const row=db.prepare(`SELECT r.id resultId,c.id callId,${p('id','r.record_json')} resultIdentity,${p('id','c.record_json')} callIdentity,
        ${['productId','productRevision','providerId','model'].flatMap(key=>[`${p(key,'r.record_json')} r_${key}`,`${p(key,'c.record_json')} c_${key}`]).join(',')},
        ${p('callId','r.record_json')} ownerCallId,${p('createdAt','r.record_json')} createdAt,${p('status','c.record_json')} status,${p('finishedAt','c.record_json')} finishedAt,
        ${p('output.kind','r.record_json')} kind,${p('output.phase','r.record_json')} phase,${p('output.productType','r.record_json')} productType,${p('output.selection.outcome','r.record_json')} outcome,
        ${p('categoryContext.phase','c.record_json')} callPhase,${p('categoryContext.operationId','c.record_json')} operationId,${p('categoryContext.version','c.record_json')} contextVersion,
        ${p('requestScope.operation','c.record_json')} ownerOperation,${p('requestScope.productId','c.record_json')} ownerProduct,${p('requestScope.phase','c.record_json')} ownerPhase,
        ${p('requestScope','c.record_json')} ownerScope,${p('requestFingerprint','c.record_json')} requestFingerprint,${p('providerReceiptId','c.record_json')} providerReceiptId,
        ${p('providerReceiptRecovery','r.record_json')} recovery
        FROM ai_results r JOIN ai_calls c ON c.id=${p('callId','r.record_json')} WHERE r.id=?`).get(resultId);
      if(!row||row.resultIdentity!==resultId||row.callIdentity!==row.callId||!evidenceId(row.callId)||row.ownerCallId!==row.callId
        ||row.r_productId!==item.productId||row.c_productId!==item.productId||row.r_productRevision!==item.productRevision||row.c_productRevision!==item.productRevision
        ||typeof row.r_model!=='string'||!row.r_model||row.r_model!==row.c_model||!['deepseek','deepseek-review','openrouter','openrouter-review'].includes(String(row.r_providerId))||row.r_providerId!==row.c_providerId
        ||row.kind!=='category-decision'||row.phase!==phases[index]||row.callPhase!==null&&row.callPhase!==row.phase||row.outcome==='NO_SUITABLE'
        ||row.ownerOperation!==null&&row.ownerOperation!=='category'||row.ownerProduct!==null&&row.ownerProduct!==item.productId||row.ownerPhase!==null&&row.ownerPhase!==row.phase
        ||!evidenceTime(row.createdAt)||!evidenceTime(row.finishedAt)||!recoveryOwner(row)
        ||index===0&&row.productType!==null||index>0&&!c.candidateTypes.includes(row.productType)||index===phases.length-1&&row.productType!==c.productType
        ||row.operationId!==null&&!evidenceId(row.operationId)||row.contextVersion===2&&row.operationId!==categoryOperationId(item.productId))invalid();
      references.push({item,resultId,callId:row.callId as string,operationId:row.operationId as string|null});
    }
  }
  return references;
}
