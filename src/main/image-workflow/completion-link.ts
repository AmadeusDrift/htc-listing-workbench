import type { DatabaseSync } from 'node:sqlite';
import { UserFacingError } from '../../shared/errors.ts';

/** M08 narrow legacy link: preserve every other field and compare the exact prior record. */
export function linkLegacyPreparation(db:DatabaseSync,input:{id:string;draftId:string;operationId:string;expectedJson:string}):void {
  if(!db.isTransaction)throw new UserFacingError('图片准备关联必须加入字段操作事务');
  const changed=db.prepare(`UPDATE image_workflow_runs SET record_json=json_set(record_json,'$.contentPreparation.operationId',?)
    WHERE id=? AND record_json=? AND json_extract(record_json,'$.draftId')=?
    AND json_extract(record_json,'$.contentPreparation.state')='STARTED'
    AND json_type(record_json,'$.contentPreparation.operationId') IS NULL`).run(input.operationId,input.id,input.expectedJson,input.draftId);
  if(changed.changes!==1)throw new UserFacingError('图片准备记录已变化，字段操作未关联');
}
