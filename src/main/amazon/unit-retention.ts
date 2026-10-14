import type{DatabaseSync}from'node:sqlite';
import type{DraftRecord}from'./persistence.ts';
import{UserFacingError}from'../../shared/errors.ts';
/** M06 staged restore only; no source mutation, provider call, submission or permission. */
export function restoreSalesUnitRecord(db:DatabaseSync,record:DraftRecord):void{
 if(!db.isTransaction)throw new UserFacingError('计量恢复必须使用暂存数据库同步事务');
 const d=record.draft;if(!d.salesPlan?.unitAdoption)throw new UserFacingError('计量恢复缺少明确采用证明');
 const changes=db.prepare('UPDATE listing_drafts SET request_json=?,schema_checksum=?,validation_json=?,preview_json=?,state=?,record_json=?,updated_at=? WHERE id=? AND product_id=? AND target_id=?').run(JSON.stringify(record.request),d.schema.checksum,JSON.stringify(d.localIssues),record.previewResponse?JSON.stringify(record.previewResponse):null,d.state,JSON.stringify(record),d.updatedAt,d.id,d.productId,d.targetId).changes;
 if(changes!==1)throw new UserFacingError('计量恢复的原草稿已变化');
}
