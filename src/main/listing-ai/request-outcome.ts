import type { AiCall } from '../../shared/ai-contracts.ts';

/** These persisted codes originate from an explicit provider rejection, not a lost response. */
export function isDefinitiveFieldRejection(call:AiCall):boolean {
  return call.status==='FAILED'&&['AUTH_FAILED','MODEL_REGION_RESTRICTED','ROUTING_FORBIDDEN','SERVICE_PERMISSION_REQUIRED','QUOTA_EXCEEDED','RATE_LIMITED'].includes(call.errorCode??'');
}
