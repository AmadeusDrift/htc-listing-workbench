import type { DatabaseSync } from 'node:sqlite';
import type { CopyReviewSettings, ImageWorkflowRun } from '../../shared/image-workflow-contracts.ts';
import { keys } from '../ai/validation.ts';
import { UserFacingError } from '../../shared/errors.ts';

const KEY='listing_copy_review_v1';
function parse(raw:unknown):CopyReviewSettings{
  const value=keys(raw,['enabled']);if(typeof value.enabled!=='boolean')throw new UserFacingError('文案复核开关值无效');return {enabled:value.enabled};
}
export function readCopyReviewSettings(db:DatabaseSync):CopyReviewSettings{
  const row=db.prepare('SELECT value_json FROM amazon_settings WHERE key=?').get(KEY);return row?parse(JSON.parse(String(row.value_json))):{enabled:true};
}
export function writeCopyReviewSettings(db:DatabaseSync,raw:unknown):CopyReviewSettings{
  const value=parse(raw);db.prepare('INSERT INTO amazon_settings(key,value_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run(KEY,JSON.stringify(value));return value;
}
export function copyReviewPolicyCompatible(run:ImageWorkflowRun|null|undefined,enabled:boolean):boolean{
  return !enabled||!!run&&run.copyReviewEnabled!==false&&!run.imageContext?.copyReviewBypass;
}
