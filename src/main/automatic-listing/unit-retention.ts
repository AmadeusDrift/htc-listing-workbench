import type{DatabaseSync}from'node:sqlite';
import type{AutomaticListingTask}from'../../shared/automatic-listing-contracts.ts';
import{validateAutomaticListingTask}from'./records.ts';
import{assertTaskAdaptationHistory}from'./adaptation.ts';
import{assertAutomaticRejectionHistory}from'./rejection-history.ts';
import{UserFacingError}from'../../shared/errors.ts';
/** M11 staged restore only; never publishes to running service memory or schedules work. */
export function restoreSalesUnitTask(db:DatabaseSync,task:AutomaticListingTask):void{
 if(!db.isTransaction||task.status!=='PAUSED')throw new UserFacingError('计量恢复仅限暂停暂存任务');
 validateAutomaticListingTask(task);assertTaskAdaptationHistory(db,task);assertAutomaticRejectionHistory(db,task);
 if(db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(task),task.id).changes!==1)throw new UserFacingError('计量恢复的原任务已变化');
}
