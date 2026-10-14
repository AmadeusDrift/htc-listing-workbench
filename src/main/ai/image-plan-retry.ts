import type { AiCall } from '../../shared/ai-contracts.ts';
import { readInvalidAiOutputs } from './output-diagnostics.ts';

/** A missing response is not evidence of failure, even when its usage is known. */
export function imagePlanFailureConfirmed(directory:string,call:AiCall):boolean {
  if(call.status!=='FAILED')return false;
  if(['AUTH_FAILED','SERVICE_PERMISSION_REQUIRED','QUOTA_EXCEEDED','RATE_LIMITED'].includes(call.errorCode??''))return true;
  return call.errorCode==='OUTPUT_INVALID' && (call.responseReceived===true || readInvalidAiOutputs(directory,call,'image-plan').some(output=>typeof output==='string'?output.trim().length>0:output!==null&&typeof output==='object'));
}
