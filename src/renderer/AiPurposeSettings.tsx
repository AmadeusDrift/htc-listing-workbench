import './ai-purpose-settings.css';
import { useFormGuard } from './FormGuard';
import { useEffect,useState } from 'react';
import { AI_PURPOSE_LABELS } from '../shared/ai-purpose-contracts';
import type { AiPurposeProfile,TextModelCapability,ReasoningEffort,AiPurposeId } from '../shared/ai-purpose-contracts';
import type { AiConnection } from '../shared/ai-connection-contracts';
import { errorText } from './utils';

const effortNames:Record<ReasoningEffort,string>={none:'关闭',low:'低',medium:'中',high:'高',xhigh:'更高',max:'最高',not_applicable:'此接口不提供思考档位'};
function PurposeRow({profile,profiles,models,connections,busy,saved}:{profile:AiPurposeProfile;profiles:AiPurposeProfile[];models:TextModelCapability[];connections:AiConnection[];busy:boolean;saved:(p:AiPurposeProfile)=>void}){
  const [draft,setDraft]=useState(profile),[working,setWorking]=useState(false),[error,setError]=useState(''),[copySource,setCopySource]=useState('');
  const dirty=draft.gateway!==profile.gateway||draft.model!==profile.model||draft.effort!==profile.effort||draft.upgradePurposeId!==profile.upgradePurposeId;
  useEffect(()=>{if(!dirty)setDraft(profile);},[profile]);
  const vision=['source_understanding','category_analysis','image_plan','image_plan_repair','appearance_review','appearance_review_difficult'].includes(profile.purposeId);
  const options=models.filter(m=>(m.endpoint==='decisions')===profile.purposeId.endsWith('_decision'));
  const selected=options.find(m=>m.gateway===draft.gateway&&m.model===draft.model),valid=!!selected&&selected.efforts.includes(draft.effort)&&(!vision||selected.vision);
  const label=AI_PURPOSE_LABELS[profile.purposeId];
  function copySaved() {
    const source=profiles.find(p=>p.purposeId===copySource);
    if(!source)return;
    const model=models.find(m=>m.gateway===source.gateway&&m.model===source.model);
    const upgrade=profiles.find(p=>p.purposeId===source.upgradePurposeId);
    const upgradeModel=upgrade&&models.find(m=>m.gateway===upgrade.gateway&&m.model===upgrade.model);
    let reason='';
    if(!model)reason='来源模型不在当前能力目录中。';
    else if((model.endpoint==='decisions')!==profile.purposeId.endsWith('_decision'))reason='Decisions 与普通文案用途不能互相复制。';
    else if(vision&&!model.vision)reason='目标用途需要图片理解；来源模型不支持图片。';
    else if(vision&&source.upgradePurposeId&&!upgradeModel?.vision)reason='来源疑难升级目标不支持所需图片理解能力。';
    else if(!model.efforts.includes(source.effort))reason='来源思考档位不受当前模型支持。';
    else if(source.gateway==='deepseek'&&!connections.find(c=>c.id==='deepseek')?.profiles.some(p=>p.configured))reason='请先在 DeepSeek 独立连接中保存 Key。';
    else if(source.upgradePurposeId===profile.purposeId)reason='复制会让疑难升级指向自身，请先调整来源已保存配置。';
    else if(profile.purposeId.endsWith('_decision')&&source.upgradePurposeId)reason='Decisions 用途不支持疑难升级目标。';
    if(reason){setError(reason+' 未修改此用途。');return;}
    setDraft(current=>({...current,...structuredClone({gateway:source.gateway,model:source.model,effort:source.effort,upgradePurposeId:source.upgradePurposeId})}));
    setError('');
  }
  async function save(){
    if(working||busy||!valid)return false;if(!dirty)return true;setWorking(true);setError('');
    try{const value=await window.red.saveAiPurposeProfile({purposeId:profile.purposeId,expectedRevision:draft.revision,patch:{gateway:draft.gateway,model:draft.model,effort:draft.effort,upgradePurposeId:draft.upgradePurposeId}});setDraft(value);saved(value);return true;}
    catch(cause){setError(errorText(cause));return false;}finally{setWorking(false);}
  }
  useFormGuard({dirty:()=>dirty,save,discard:()=>{setDraft(structuredClone(profile));setError('');}});
  return <div className="ai-function-row" data-ai-purpose={profile.purposeId}>
    <div className="credential-heading"><strong>{label}</strong><span className="small-copy">{profile.source==='user'?'独立配置':profile.source==='legacy-function'?'沿用旧偏好':'默认配置'}</span></div>
    <div className="ai-function-controls">
      {draft.gateway==='openrouter'&&<p className="settings-help">提供商：OpenRouter 自动选择；固定所选模型，实际模型与提供商以调用回执为准，可在下方用量明细查看。新策略仅适用于新发送请求；已提交批次保留原路由。</p>}
      <label className="field"><span>模型与渠道</span><select aria-label={label+'模型'} value={draft.gateway+':'+draft.model} disabled={busy||working} onChange={event=>{const model=options.find(m=>m.gateway+':'+m.model===event.target.value);if(model)setDraft({...draft,gateway:model.gateway,model:model.model});}}>{options.map(m=>{const missing=m.gateway==='deepseek'&&!connections.find(c=>c.id==='deepseek')?.profiles.some(p=>p.configured);const unsupported=vision&&!m.vision;return <option key={m.gateway+':'+m.model} value={m.gateway+':'+m.model} disabled={missing||unsupported}>{m.gateway==='openrouter'?'OpenRouter':'DeepSeek独立接口'} · {m.name}{missing?'（先保存Key）':unsupported?'（不支持图片）':''}</option>;})}</select></label>
      <label className="field"><span>思考强度</span><select aria-label={label+'思考强度'} value={draft.effort} disabled={busy||working} onChange={event=>setDraft({...draft,effort:event.target.value as ReasoningEffort})}>{!selected?.efforts.includes(draft.effort)&&<option value={draft.effort} disabled>当前模型不支持，请重新选择</option>}{selected?.efforts.map(e=><option key={e} value={e}>{effortNames[e]}</option>)}</select></label>
      {!profile.purposeId.endsWith('_decision')&&<label className="field"><span>疑难升级目标</span><select aria-label={label+'疑难目标'} value={draft.upgradePurposeId??''} disabled={busy||working} onChange={event=>setDraft({...draft,upgradePurposeId:event.target.value?(event.target.value as AiPurposeId):null})}><option value="">不升级</option>{profiles.filter(p=>p.purposeId.endsWith('_difficult')&&p.purposeId!==profile.purposeId).map(p=><option key={p.purposeId} value={p.purposeId}>{AI_PURPOSE_LABELS[p.purposeId]}</option>)}</select></label>}
      <button type="button" className="button secondary" disabled={busy||working||!dirty||!valid} onClick={()=>void save()}>{working?'正在保存…':'保存此用途'}</button>
    </div>
    <div className="ai-purpose-copy"><label className="field"><span>从已保存用途复制</span><select aria-label={label+'复制来源'} value={copySource} disabled={busy||working} onChange={event=>setCopySource(event.target.value)}><option value="">选择来源用途</option>{profiles.filter(p=>p.purposeId!==profile.purposeId).map(p=><option key={p.purposeId} value={p.purposeId}>{AI_PURPOSE_LABELS[p.purposeId]}</option>)}</select></label><button type="button" className="button secondary" disabled={busy||working||!copySource} onClick={copySaved}>复制为未保存设置</button><p className="small-copy">只复制来源已保存的模型、渠道、思考和升级目标；此用途需另行保存，来源后续修改不会联动。</p></div>
    {!valid&&<p className="workflow-warning">所选模型不支持当前模式或思考档位，请明确调整；系统不会换模型。</p>}
    {dirty&&<p className="small-copy">此用途尚未保存</p>}{error&&<p className="workflow-warning" role="alert">{error}</p>}
  </div>;
}
export function AiPurposeSettings({busy}:{busy:boolean}){
  const [profiles,setProfiles]=useState<AiPurposeProfile[]>([]),[models,setModels]=useState<TextModelCapability[]>([]),[connections,setConnections]=useState<AiConnection[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  useEffect(()=>{
    let active=true;const load=()=>{void Promise.all([window.red.getAiPurposeProfiles(),window.red.getAiTextModelCapabilities(),window.red.listAiConnections()]).then(([p,m,c])=>{if(active){setProfiles(p);setModels(m);setConnections(c);setError('');}}).catch(cause=>{if(active)setError(errorText(cause));}).finally(()=>{if(active)setLoading(false);});};
    load();window.addEventListener('htc-ai-connections-changed',load);return()=>{active=false;window.removeEventListener('htc-ai-connections-changed',load);};
  },[]);
  return <section className="ai-functions" aria-label="逐用途模型与思考设置" aria-busy={loading}>
    <h4>逐用途模型与思考</h4><p className="settings-help">每项独立保存。同配置的文案可合并调用，不同配置分别执行；在途请求保留原快照。目录能力不等于账号权限。DeepSeek 使用自身密钥，Decisions 与生图当前按普通接口计费。</p>
    {loading&&<p role="status">正在读取用途配置…</p>}{error&&<p className="workflow-warning" role="alert">{error}</p>}
    {profiles.map(profile=><PurposeRow key={profile.purposeId} profile={profile} profiles={profiles} models={models} connections={connections} busy={busy} saved={value=>setProfiles(prior=>prior.map(p=>p.purposeId===value.purposeId?value:p))}/>)}
  </section>;
}
