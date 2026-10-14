import type { AiCall } from '../../shared/ai-contracts.ts';
import { hasRetainedInvalidAiOutput } from './output-diagnostics.ts';

/** A missing response is not evidence of failure, even when its usage is known. */
export function imagePlanFailureConfirmed(directory:string,call:AiCall):boolean {
  if(call.status!=='FAILED')return false;
  if(['AUTH_FAILED','SERVICE_PERMISSION_REQUIRED','QUOTA_EXCEEDED','RATE_LIMITED'].includes(call.errorCode??''))return true;
  return call.errorCode==='OUTPUT_INVALID' && (call.responseReceived===true || hasRetainedInvalidAiOutput(directory,call,'image-plan'));
}
