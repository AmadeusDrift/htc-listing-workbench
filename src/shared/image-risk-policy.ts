import type { ImageIpReviewOutput } from './image-ai-contracts.ts';
import type { ImageRiskSettings } from './image-workflow-contracts.ts';
/** Aliyun ImageModeration, aigcViolationDetection table 12. Confidence is not infringement probability. */
const riskLabels=new Set('tm_auto tm_electronic tm_fashion tm_goods logo_sns logo_lifestyle logo_streaming logo_finance logo_retail logo_news logo_enterprise logo_tv cartoon_ip public_celebrity public_politician'.split(' '));
const levels=['none','low','medium','high'];
export function imageRiskPolicy(settings:ImageRiskSettings={enabled:true}){return {enabled:settings.enabled,scoreThreshold:settings.scoreThreshold??90,levelThreshold:settings.levelThreshold??'high'};}
export function evaluateImageRisk(output:Pick<ImageIpReviewOutput,'riskLevel'|'labels'>,settings:ImageRiskSettings={enabled:true}){
 const policy=imageRiskPolicy(settings),triggers:string[]=[],scores:number[]=[];let incomplete=!output.labels.length||!levels.includes(output.riskLevel);
 for(const item of output.labels){
  const label=item.label.endsWith('_lib')?item.label.slice(0,-4):item.label;
  if(item.label==='nonLabel')continue;
  if(item.label==='nonLabel_lib'){if(typeof item.confidence!=='number'||!Number.isFinite(item.confidence)||item.confidence<0||item.confidence>100)incomplete=true;continue;}
  if(!riskLabels.has(label)){incomplete=true;continue;}
  if(typeof item.confidence!=='number'||!Number.isFinite(item.confidence)||item.confidence<0||item.confidence>100){incomplete=true;continue;}
  scores.push(item.confidence);
  if(item.confidence>policy.scoreThreshold)triggers.push(`${item.label} ${item.confidence} > ${policy.scoreThreshold}`);
 }
 if(levels.includes(output.riskLevel)&&levels.indexOf(output.riskLevel)>=levels.indexOf(policy.levelThreshold))triggers.push(`等级 ${output.riskLevel} ≥ ${policy.levelThreshold}`);
 const verdict=!policy.enabled?'SKIPPED':triggers.length?'BLOCKED':incomplete?'UNCERTAIN':'PASS';
 return {verdict:verdict as 'PASS'|'BLOCKED'|'UNCERTAIN'|'SKIPPED',policy,riskScore:scores.length?Math.max(...scores):null,riskLevel:output.riskLevel,triggers,incomplete};
}
export function describeImageRisk(output:ImageIpReviewOutput,settings:ImageRiskSettings,sku:string,slot:number){
 const decision=evaluateImageRisk(output,settings);
 return `SKU ${sku} · 图片 ${slot} · 生成图阿里云 aigcViolationDetection：实际风险标签分数 ${decision.riskScore??'未提供/不适用'}；实际等级 ${output.riskLevel}；当前阈值 分数 > ${decision.policy.scoreThreshold} 或等级 ≥ ${decision.policy.levelThreshold}；当前解释 ${decision.verdict}；触发 ${decision.triggers.join('；')|| (decision.incomplete?'必需评分缺失或标签未知':'无')}；原结论 ${output.verdict}；${output.labels.map(item=>`${item.label}：${item.confidence??'未提供'}${item.label==='nonLabel_lib'?'（安全库相似度，非风险分数）':riskLabels.has(item.label.replace(/_lib$/,''))?(item.label.endsWith('_lib')?'（风险库相似度）':'（风险标签置信度）'):'（原始值，未用作风险分数）'}`).join('；')}。分数不是侵权概率；nonLabel 也可能表示检测项均关闭。`;
}
