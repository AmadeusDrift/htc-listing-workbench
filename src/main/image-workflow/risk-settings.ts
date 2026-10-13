import { writeOwnedSetting } from '../storage/settings.ts';
import { imageRiskPolicy, evaluateImageRisk } from '../../shared/image-risk-policy.ts';
import type { ImageIpReviewOutput } from '../../shared/image-ai-contracts.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { ImageRiskSettings, ImageWorkflowRun } from '../../shared/image-workflow-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { keys } from "../ai/primitives.ts";

const KEY='image_risk_interception_v1';
export function readImageRiskSettings(db:DatabaseSync):ImageRiskSettings {
  const row=db.prepare('SELECT value_json FROM amazon_settings WHERE key=?').get(KEY);
  return row?parseImageRiskSettings(JSON.parse(String(row.value_json))):imageRiskPolicy();
}
export function parseImageRiskSettings(raw:unknown):ImageRiskSettings {
  const value=keys(raw,['enabled'],['scoreThreshold','levelThreshold']);
  if(typeof value.enabled!=='boolean')throw new UserFacingError('风险拦截开关值无效');
  const score=value.scoreThreshold===undefined?90:value.scoreThreshold,level=value.levelThreshold===undefined?'high':value.levelThreshold;
  if(typeof score!=='number'||!Number.isFinite(score)||score<0||score>100||!['low','medium','high'].includes(String(level)))throw new UserFacingError('风险阈值无效：分数须为 0–100，等级须为 low/medium/high');
  return {enabled:value.enabled,scoreThreshold:score,levelThreshold:level as 'low'|'medium'|'high'};
}
export function writeImageRiskSettings(db:DatabaseSync,raw:unknown):ImageRiskSettings {
  const value=parseImageRiskSettings(raw);
  writeOwnedSetting(db,'images',KEY,JSON.stringify(value));
  return value;
}
export function riskPolicyCompatible(run:ImageWorkflowRun|null|undefined,settings:ImageRiskSettings,getOutput:(id:string)=>ImageIpReviewOutput|undefined):boolean {
  const policy=settings;
  if(!policy.enabled)return true;
  if(!run||run.riskInterceptionEnabled===false||run.slots?.some(slot=>slot.attempts.some(attempt=>attempt.riskBypass)))return false;
  if(run.slots)return run.slots.filter(slot=>slot.status==='PASSED').every(slot=>{
    const attempt=slot.attempts.at(-1),output=attempt?.ipReviewResultId?getOutput(attempt.ipReviewResultId):undefined;
    return !!output&&output.candidate.id===attempt?.candidateId&&output.candidate.sha256===slot.approvedSha256&&output.planResultId===attempt.planResultId&&evaluateImageRisk(output,policy).verdict==='PASS';
  });
  const id=run.ipReviewResultIds?.at(-1),output=id?getOutput(id):undefined;
  return !!output&&output.candidate.id===run.candidateIds.at(-1)&&output.candidate.sha256===run.approvedSha256&&output.planResultId===run.planResultIds.at(-1)&&evaluateImageRisk(output,policy).verdict==='PASS';
}
