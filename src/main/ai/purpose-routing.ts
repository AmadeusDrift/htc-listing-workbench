import { taskAiContext } from './batch/task-context.ts';
import type { DatabaseSync } from 'node:sqlite';
import { AI_PURPOSE_IDS } from '../../shared/ai-purpose-contracts.ts';
import type { AiPurposeId,AiPurposeProfile,AiPurposeSnapshot,SaveAiPurposeInput,ReasoningEffort } from '../../shared/ai-purpose-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { checkReasoning } from './model-capabilities.ts';
import { transaction } from '../application/transaction.ts';
import { assertRecordTable } from '../storage/record-table.ts';

export const PURPOSE_TABLES={ai_purpose_profiles:['id','record_json']};
export const reviewPurpose=(id:AiPurposeId)=>['copy_review','copy_review_difficult','image_text_review','appearance_review','appearance_review_difficult'].includes(id);
export function purposeId(value:unknown):AiPurposeId{if(typeof value!=='string'||!AI_PURPOSE_IDS.includes(value as AiPurposeId))throw new UserFacingError('未登记的AI用途');return value as AiPurposeId;}
function parse(raw:unknown):AiPurposeProfile{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new UserFacingError('用途配置无效');const r=raw as AiPurposeProfile;
  if(Object.keys(r).sort().join()!=='effort,gateway,model,purposeId,revision,source,upgradePurposeId'||!Number.isSafeInteger(r.revision)||r.revision<0||!['builtin','legacy-function','user'].includes(r.source))throw new UserFacingError('用途配置格式无效');
  purposeId(r.purposeId);if(r.upgradePurposeId!==null)purposeId(r.upgradePurposeId);const cap=checkReasoning(r.gateway,r.model,r.effort);
  if(r.purposeId.endsWith('_decision')!==(cap.endpoint==='decisions'))throw new UserFacingError('文案与专用Decisions模型不可混用');return structuredClone(r);
}
function write(db:DatabaseSync,value:AiPurposeProfile){db.prepare('INSERT INTO ai_purpose_profiles(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(value.purposeId,JSON.stringify(parse(value)));}
export function initializePurposeProfiles(db:DatabaseSync):void{
  transaction(db,()=>{
    db.exec('CREATE TABLE IF NOT EXISTS ai_purpose_profiles(id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL)');
    for(const id of AI_PURPOSE_IDS){
      if(db.prepare('SELECT 1 FROM ai_purpose_profiles WHERE id=?').get(id))continue;
      if(id.endsWith('_decision')){write(db,{purposeId:id,revision:0,gateway:'openrouter',model:'openai/gpt-6-luna-decisions',effort:'not_applicable',upgradePurposeId:null,source:'builtin'});continue;}
      const raw=db.prepare('SELECT record_json FROM ai_profiles WHERE id=?').get(reviewPurpose(id)?'deepseek-review':'deepseek');
      const legacy=raw?JSON.parse(String(raw.record_json)):null,difficult=id.endsWith('_difficult');
      const preserve=legacy?.configured===true&&!id.startsWith('appearance_');
      const fixedVision=['source_understanding','category_analysis','image_plan','image_plan_repair'].includes(id);
      write(db,{purposeId:id,revision:0,gateway:preserve?'deepseek':'openrouter',model:preserve?(fixedVision?'deepseek-flash':legacy.model):(difficult?'openai/gpt-6.1-sol':'openai/gpt-6-luna'),effort:preserve?(legacy.thinking?'high':'none'):'medium',upgradePurposeId:id==='copy_review'?'copy_review_difficult':id==='appearance_review'?'appearance_review_difficult':null,source:preserve?'legacy-function':'builtin'});
    }
  });
}
export function readPurposeProfile(db:DatabaseSync,id:AiPurposeId):AiPurposeProfile{
  const key=purposeId(id),row=db.prepare('SELECT record_json FROM ai_purpose_profiles WHERE id=?').get(key);if(!row)throw new UserFacingError('AI用途尚未初始化');
  const value=parse(JSON.parse(String(row.record_json)));if(value.purposeId!==key)throw new UserFacingError('AI用途身份不一致');return value;
}
export function listPurposeProfiles(db:DatabaseSync):AiPurposeProfile[]{return AI_PURPOSE_IDS.map(id=>readPurposeProfile(db,id));}
export function savePurposeProfile(db:DatabaseSync,input:SaveAiPurposeInput):AiPurposeProfile{
  return transaction(db,()=>{
    if(!input||Object.keys(input).sort().join()!=='expectedRevision,patch,purposeId'||!input.patch||Array.isArray(input.patch)||typeof input.patch!=='object'||Object.keys(input.patch).some(key=>!['gateway','model','effort','upgradePurposeId'].includes(key)))throw new UserFacingError('用途设置仅允许保存本用途字段');
    const previous=readPurposeProfile(db,input.purposeId);if(previous.revision!==input.expectedRevision)throw new UserFacingError('用途配置版本已变化，请重新加载');
    const next=parse({...previous,...input.patch,revision:previous.revision+1,source:'user'});
    const seen=new Set([next.purposeId]);let target=next.upgradePurposeId;
    while(target){if(seen.has(target))throw new UserFacingError('疑难升级配置存在循环');seen.add(target);target=readPurposeProfile(db,target).upgradePurposeId;}
    write(db,next);return next;
  });
}
export function resolvePurpose(db:DatabaseSync,id:AiPurposeId,needs:{vision?:boolean}={}):AiPurposeSnapshot{
  const frozen=taskAiContext.getStore()?.purposes?.find(p=>p.purposeId===id);
  if(frozen){if(needs.vision&&!frozen.capability.vision)throw new UserFacingError('任务用途快照不支持视觉，未替换模型');return structuredClone(frozen);}
  const profile=readPurposeProfile(db,id),capability=checkReasoning(profile.gateway,profile.model,profile.effort);
  if(needs.vision&&!capability.vision)throw new UserFacingError(`${capability.name} 不支持本用途需要的图片输入，未替换模型或省略图片`);
  const base={...profile,requestedEffort:profile.effort,effectiveEffort:profile.effort,capability};
  let upgrade:AiPurposeSnapshot['upgrade']=null;
  if(profile.upgradePurposeId){const p=readPurposeProfile(db,profile.upgradePurposeId),c=checkReasoning(p.gateway,p.model,p.effort);if(needs.vision&&!c.vision)throw new UserFacingError('疑难目标不支持所需视觉能力');upgrade={...p,requestedEffort:p.effort,effectiveEffort:p.effort,capability:c};}
  return{...base,upgrade};
}
/** Compatibility command only: an explicit old function-model save seeds untouched purpose settings. */
export function inheritLegacyPurposeSettings(db:DatabaseSync,role:'deepseek'|'deepseek-review',model:string,thinking:boolean):void{
  transaction(db,()=>{for(const p of listPurposeProfiles(db))if(p.source!=='user'&&!p.purposeId.endsWith('_decision')&&!p.purposeId.startsWith('appearance_')&&reviewPurpose(p.purposeId)===(role==='deepseek-review')){
    const selected=['source_understanding','category_analysis','image_plan','image_plan_repair'].includes(p.purposeId)?'deepseek-flash':model;
    if(p.gateway!=='deepseek'||p.model!==selected||p.effort!==(thinking?'high':'none')||p.source!=='legacy-function')write(db,{...p,revision:p.revision+1,gateway:'deepseek',model:selected,effort:(thinking?'high':'none') as ReasoningEffort,source:'legacy-function'});
  }});
}
export function assertPurposeHistory(db:DatabaseSync):void{
  if(Number(db.prepare('PRAGMA user_version').get()!.user_version)<25)return;
  assertRecordTable(db,'ai_purpose_profiles');
  if(db.prepare('SELECT count(*) n FROM ai_purpose_profiles').get()!.n!==AI_PURPOSE_IDS.length)throw new UserFacingError('用途配置数量无效');
  for(const id of AI_PURPOSE_IDS){
    const seen=new Set<AiPurposeId>();let next:AiPurposeId|null=id;
    while(next){if(seen.has(next))throw new UserFacingError('疑难升级配置存在循环');seen.add(next);next=readPurposeProfile(db,next).upgradePurposeId;}
    resolvePurpose(db,id);
  }
}
export function validatePurposeSnapshot(raw:unknown):AiPurposeSnapshot{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new UserFacingError('用途执行快照无效');
  const r=raw as AiPurposeSnapshot;
  if(Object.keys(r).sort().join()!=='capability,effectiveEffort,effort,gateway,model,purposeId,requestedEffort,revision,source,upgrade,upgradePurposeId')throw new UserFacingError('用途执行快照字段无效');
  const base=parse(Object.fromEntries(['purposeId','revision','gateway','model','effort','upgradePurposeId','source'].map(k=>[k,(r as unknown as Record<string,unknown>)[k]])));
  const c=r.capability;
  if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(k=>!['gateway','model','name','vision','json','efforts','batch','verifiedAt','sourceUrl','accountVerified','endpoint'].includes(k))||typeof c.name!=='string'||!c.name.length||c.name.length>200||typeof c.vision!=='boolean'||typeof c.json!=='boolean'||typeof c.batch!=='boolean'||c.accountVerified!==false||!/^\d{4}-\d{2}-\d{2}$/.test(c.verifiedAt)||typeof c.sourceUrl!=='string'||!/^https:\/\//.test(c.sourceUrl)||c.sourceUrl.length>2048||!Array.isArray(c.efforts)||!c.efforts.length||new Set(c.efforts).size!==c.efforts.length||c.efforts.some(e=>!['none','low','medium','high','xhigh','max','not_applicable'].includes(e))||c.endpoint!==undefined&&!['chat','decisions'].includes(c.endpoint))throw new UserFacingError('用途能力快照无效');
  if(r.requestedEffort!==base.effort||r.effectiveEffort!==base.effort||c.model!==base.model||c.gateway!==base.gateway||!c.efforts.includes(r.effectiveEffort)||(c.endpoint==='decisions')!==base.purposeId.endsWith('_decision')||base.gateway==='deepseek'&&c.batch)throw new UserFacingError('用途执行能力或思考快照不一致');
  if((r.upgrade===null)!==(base.upgradePurposeId===null))throw new UserFacingError('疑难升级快照缺失');
  if(r.upgrade){const nested=validatePurposeSnapshot({...r.upgrade,upgradePurposeId:null,upgrade:null});if(nested.purposeId!==base.upgradePurposeId||nested.purposeId===base.purposeId)throw new UserFacingError('疑难升级快照不一致');}
  return structuredClone(r);
}
