import type { DatabaseSync } from 'node:sqlite';
import type { ImageRiskSettings, ImageWorkflowRun } from '../../shared/image-workflow-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { keys } from '../ai/validation.ts';

const KEY='image_risk_interception_v1';
export function readImageRiskSettings(db:DatabaseSync):ImageRiskSettings {
  const row=db.prepare('SELECT value_json FROM amazon_settings WHERE key=?').get(KEY);
  return row?parseImageRiskSettings(JSON.parse(String(row.value_json))):{enabled:true};
}
export function parseImageRiskSettings(raw:unknown):ImageRiskSettings {
  const value=keys(raw,['enabled']);
  if(typeof value.enabled!=='boolean')throw new UserFacingError('风险拦截开关值无效');
  return {enabled:value.enabled};
}
export function writeImageRiskSettings(db:DatabaseSync,raw:unknown):ImageRiskSettings {
  const value=parseImageRiskSettings(raw);
  db.prepare('INSERT INTO amazon_settings(key,value_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run(KEY,JSON.stringify(value));
  return value;
}
export function riskPolicyCompatible(run:ImageWorkflowRun|null|undefined,enabled:boolean):boolean {
  return !enabled||!!run&&run.riskInterceptionEnabled!==false&&!run.slots?.some(slot=>slot.attempts.some(attempt=>attempt.riskBypass));
}
