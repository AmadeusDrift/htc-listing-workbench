import type { DatabaseSync } from 'node:sqlite';
import { validateAutomaticListingTask } from './records.ts';
import { UserFacingError } from '../../shared/errors.ts';
/** Restore never grants work and cannot roll back the bounded GET budget. */
export function retainSchemaRetryBudgets(current:DatabaseSync,snapshot:DatabaseSync):void {
  const has=(db:DatabaseSync)=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='automatic_listing_tasks'").get();
  if(!has(current)||!has(snapshot))return;
  for(const saved of current.prepare('SELECT id,record_json FROM automatic_listing_tasks').all()){
    const task=validateAutomaticListingTask(JSON.parse(String(saved.record_json)));
    if(!task.items.some(row=>row.schemaRetry))continue;
    const old=snapshot.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(task.id);
    if(!old)continue; // A task absent from the chosen snapshot cannot resume.
    const restored=validateAutomaticListingTask(JSON.parse(String(old.record_json)));let changed=false;
    for(const row of restored.items){
      const latest=task.items.find(item=>item.key===row.key)?.schemaRetry;
      if(!latest)continue;
      const previous=row.schemaRetry;
      if(previous&&(previous.scope!==latest.scope||previous.firstFailureAt!==latest.firstFailureAt))throw new UserFacingError('Schema 重试历史范围冲突，未恢复备份');
      const receipt=structuredClone(!previous||latest.usedDelayedRounds>=previous.usedDelayedRounds?latest:previous);
      if(receipt.state==='IN_FLIGHT')receipt.state='WAITING';
      // A newer cache/result is not evidence inside an older backup.
      if(receipt.state==='SUCCEEDED')receipt.state='WAITING';
      row.schemaRetry=receipt;
      if(!['DONE','SCREENED'].includes(row.status)){row.status=receipt.state==='EXHAUSTED'?'FAILED':'WAITING';row.error='Schema 重试历史已保留；继续前核对原任务范围';}
      changed=true;
    }
    if(changed){if(!['COMPLETED','CANCELLED'].includes(restored.status))restored.status='PAUSED';restored.revision++;validateAutomaticListingTask(restored);snapshot.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(restored),restored.id);}
  }
}
