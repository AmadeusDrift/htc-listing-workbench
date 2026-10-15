import type { AutomaticListingTask } from '../../shared/automatic-listing-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';

export interface CancelledRecoveryInput { taskId:string; expectedRevision:number }
export interface CancelledRecoveryActivity { workerActive:boolean; confirming:boolean; archiving:boolean; preparing:boolean }

/** Local header transition only. The owner must persist with revision CAS and
 * audit in one transaction; it must not grant or schedule any task work. */
export function planCancelledTaskRecovery(task:Pick<AutomaticListingTask,'id'|'revision'|'status'>,input:CancelledRecoveryInput,activity:CancelledRecoveryActivity){
  if(input.taskId!==task.id||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1||input.expectedRevision!==task.revision)
    throw new UserFacingError('任务版本已变化，请重新核对要恢复的原任务');
  if(task.status!=='CANCELLED')throw new UserFacingError('只有已取消的任务可以恢复为暂停');
  if(activity.workerActive||activity.confirming||activity.archiving||activity.preparing)
    throw new UserFacingError('仍有任务处理或确认尚未结束，请待完全停止后再恢复');
  return {
    patch:{status:'PAUSED' as const},
    audit:{action:'automatic-listing.cancelled-restored',summary:'用户将已取消原任务恢复为暂停；未启动后续处理',detail:{version:1,taskId:task.id,fromRevision:task.revision,toRevision:task.revision+1,fromStatus:'CANCELLED' as const,toStatus:'PAUSED' as const}},
  };
}
