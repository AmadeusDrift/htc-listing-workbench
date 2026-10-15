import { AI_ERROR_CODES, AiError } from './ai/errors.ts';
import { ABORT_SOURCES, REQUEST_CERTAINTIES } from '../shared/run-evidence-contracts.ts';
import type { AbortSource, RequestCertainty } from '../shared/run-evidence-contracts.ts';
import type { ErrorStageEvidence } from '../shared/error-evidence-contracts.ts';
import { evidenceCode, evidenceId, evidenceItemKey, evidenceSku } from './diagnostics/run-evidence.ts';

export interface ErrorEvidenceContext {
  stage:string; productId?:string; taskId?:string; variantId?:string; draftId?:string|null; requestId?:string;
  executionTaskIds?:string[]; requestOutcome?:'NOT_SENT'|'DEFINITIVE_FAILURE'|'RESULT_UNKNOWN';
  callId?:string;operationId?:string;itemKey?:string;sku?:string;abortSource?:AbortSource;certainty?:RequestCertainty;
}
const codes=new Set<string>([...AI_ERROR_CODES,'EACCES','EPERM','ENOENT','ENOSPC','EIO','EROFS','EMFILE','ENFILE','ENOMEM','SQLITE_BUSY','SQLITE_FULL','SQLITE_IOERR']);
const validField=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(v);
const validPath=(v:unknown):v is string=>typeof v==='string'&&v.length<=240&&/^\$?(?:[a-zA-Z_][a-zA-Z0-9_]*|\.[a-zA-Z_][a-zA-Z0-9_]*|\[\d{1,5}\])+$/.test(v);
function networkDetail(v:unknown):import('../shared/error-evidence-contracts.ts').NetworkDiagnostic|undefined {
  if(!v||typeof v!=='object')return undefined;const n=v as any;
  if(!['DNS','CONNECTION_RESET','CONNECTION_REFUSED','TIMEOUT','TLS','PROXY','UNKNOWN'].includes(n.cause)||!['connect','body','save'].includes(n.stage)||!Number.isSafeInteger(n.receivedBytes)||n.receivedBytes<0||n.httpStatus!==undefined&&(!Number.isInteger(n.httpStatus)||n.httpStatus<100||n.httpStatus>599))return undefined;
  return {cause:n.cause,stage:n.stage,receivedBytes:n.receivedBytes,...(n.httpStatus===undefined?{}:{httpStatus:n.httpStatus})};
}
const id=(value:unknown)=>typeof value==='string'&&/^[0-9a-f-]{36}$/i.test(value)?value:undefined;

/** No messages, response bodies, absolute paths, URLs or arbitrary error properties enter this record.
 * Evidence is best effort: accessors, proxies and storage failure must not replace the original error. */
export function recordErrorEvidence(write:(detail:Record<string,unknown>)=>void,error:unknown,context:ErrorEvidenceContext):void {
  try {
    const detail:Record<string,unknown>={version:1,stage:/^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(context.stage)?context.stage:'unknown',code:'UNKNOWN_LOCAL_ERROR'};
    for(const key of ['productId','taskId','variantId','draftId','requestId','callId','operationId'] as const){const value=id(context[key]);if(value)detail[key]=value;}
    if(evidenceItemKey(context.itemKey))detail.itemKey=context.itemKey;
    if(evidenceSku(context.sku))detail.sku=context.sku;
    if(context.abortSource&&ABORT_SOURCES.includes(context.abortSource))detail.abortSource=context.abortSource;
    if(context.certainty&&REQUEST_CERTAINTIES.includes(context.certainty))detail.certainty=context.certainty;
    if(context.executionTaskIds)detail.executionTaskIds=context.executionTaskIds.slice(0,20).map(id).filter(Boolean);
    if(context.requestOutcome&&['NOT_SENT','DEFINITIVE_FAILURE','RESULT_UNKNOWN'].includes(context.requestOutcome))detail.requestOutcome=context.requestOutcome;
    if(error && typeof error==='object') {
      const code=Reflect.get(error,'code');if(typeof code==='string'&&codes.has(code))detail.code=code;
      const callId=Reflect.get(error,'callId');if(evidenceId(callId))detail.callId=callId;
      const abortSource=Reflect.get(error,'abortSource');if(ABORT_SOURCES.includes(abortSource))detail.abortSource=abortSource;
      const certainty=Reflect.get(error,'certainty');if(REQUEST_CERTAINTIES.includes(certainty))detail.certainty=certainty;
      const reason=Reflect.get(error,'diagnosticReason');if(evidenceCode(reason))detail.diagnosticReason=reason;
      const path=Reflect.get(error,'validationPath');if(validPath(path))detail.validationPath=path;
      const field=Reflect.get(error,'validationField');if(validField(field))detail.validationField=field;
      const network=networkDetail(Reflect.get(error,'networkDiagnostic'));if(network)detail.networkDiagnostic=network;
      const status=Reflect.get(error,'httpStatus');if(error instanceof AiError&&Number.isInteger(status)&&status>=400&&status<=599)detail.httpStatus=status;
      const stack=Reflect.get(error,'stack');
      if(typeof stack==='string'){
        const match=stack.slice(0,12000).replaceAll('\\','/').match(/\bsrc\/main\/(?:image-generation\/(?:service|adapter|relay-request|tyai-adapter|gemini-adapter)|automatic-listing\/service|execution\/service)\.(?:ts|js):\d{1,6}:\d{1,5}\b/);
        if(match)detail.callsite=match[0];
      }
    }
    write(detail);
  }catch{/* Diagnostic failure never changes the operational result. */}
}

/** Historical audit is untrusted. Only recognized safe fields are eligible for display/restore. */
export function readErrorEvidence(raw: unknown): ErrorStageEvidence | null {
  try {
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.getPrototypeOf(raw)!==Object.prototype)return null;
    const value=raw as Record<string,unknown>,allowed=['version','stage','code','productId','taskId','variantId','draftId','requestId','callId','operationId','itemKey','sku','abortSource','certainty','executionTaskIds','requestOutcome','httpStatus','callsite','diagnosticReason','validationPath','validationField','networkDiagnostic'];
    if(Reflect.ownKeys(value).some(k=>typeof k!=='string'||!allowed.includes(k))||Object.values(Object.getOwnPropertyDescriptors(value)).some(d=>!('value' in d))||value.version!==1||typeof value.stage!=='string'||!/^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(value.stage)||!(value.code==='UNKNOWN_LOCAL_ERROR'||typeof value.code==='string'&&codes.has(value.code)))return null;
    for(const key of ['productId','taskId','variantId','draftId','requestId','callId','operationId'])if(value[key]!==undefined&&!evidenceId(value[key]))return null;
    if(value.itemKey!==undefined&&!evidenceItemKey(value.itemKey)||value.sku!==undefined&&!evidenceSku(value.sku)||value.abortSource!==undefined&&!ABORT_SOURCES.includes(value.abortSource as AbortSource)||value.certainty!==undefined&&!REQUEST_CERTAINTIES.includes(value.certainty as RequestCertainty)||value.diagnosticReason!==undefined&&!evidenceCode(value.diagnosticReason))return null;
    if(value.validationPath!==undefined&&!validPath(value.validationPath)||value.validationField!==undefined&&!validField(value.validationField)||value.networkDiagnostic!==undefined&&!networkDetail(value.networkDiagnostic))return null;
    if(value.httpStatus!==undefined&&(!Number.isInteger(value.httpStatus)||Number(value.httpStatus)<100||Number(value.httpStatus)>599))return null;
    if(value.executionTaskIds!==undefined&&(!Array.isArray(value.executionTaskIds)||value.executionTaskIds.length>20||value.executionTaskIds.some(v=>!evidenceId(v))))return null;
    if(value.requestOutcome!==undefined&&!['NOT_SENT','DEFINITIVE_FAILURE','RESULT_UNKNOWN'].includes(String(value.requestOutcome)))return null;
    if(value.callsite!==undefined&&(typeof value.callsite!=='string'||!/^src\/main\/(?:image-generation\/(?:service|adapter|relay-request|tyai-adapter|gemini-adapter)|automatic-listing\/service|execution\/service)\.(?:ts|js):\d{1,6}:\d{1,5}$/.test(value.callsite)))return null;
    return {...value,...(value.networkDiagnostic===undefined?{}:{networkDiagnostic:networkDetail(value.networkDiagnostic)})} as unknown as ErrorStageEvidence;
  }catch{return null;}
}
