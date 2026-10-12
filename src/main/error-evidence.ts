import { AI_ERROR_CODES, AiError } from './ai/errors.ts';

export interface ErrorEvidenceContext {
  stage:string; productId?:string; taskId?:string; variantId?:string; draftId?:string|null; requestId?:string;
  executionTaskIds?:string[]; requestOutcome?:'NOT_SENT'|'DEFINITIVE_FAILURE'|'RESULT_UNKNOWN';
}
const codes=new Set<string>([...AI_ERROR_CODES,'EACCES','EPERM','ENOENT','ENOSPC','EIO','EROFS','EMFILE','ENFILE','ENOMEM','SQLITE_BUSY','SQLITE_FULL','SQLITE_IOERR']);
const id=(value:unknown)=>typeof value==='string'&&/^[0-9a-f-]{36}$/i.test(value)?value:undefined;

/** No messages, response bodies, absolute paths, URLs or arbitrary error properties enter this record.
 * Evidence is best effort: accessors, proxies and storage failure must not replace the original error. */
export function recordErrorEvidence(write:(detail:Record<string,unknown>)=>void,error:unknown,context:ErrorEvidenceContext):void {
  try {
    const detail:Record<string,unknown>={version:1,stage:/^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(context.stage)?context.stage:'unknown',code:'UNKNOWN_LOCAL_ERROR'};
    for(const key of ['productId','taskId','variantId','draftId','requestId'] as const){const value=id(context[key]);if(value)detail[key]=value;}
    if(context.executionTaskIds)detail.executionTaskIds=context.executionTaskIds.slice(0,20).map(id).filter(Boolean);
    if(context.requestOutcome)detail.requestOutcome=context.requestOutcome;
    if(error && typeof error==='object') {
      const code=Reflect.get(error,'code');if(typeof code==='string'&&codes.has(code))detail.code=code;
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
