import { useEffect, useState } from 'react';
import type { ImageRiskSettings as Settings } from '../shared/image-workflow-contracts';
import { errorText } from './utils';

export function ImageRiskSettings({visible,busy}:{visible:boolean;busy:boolean}){
  const [score,setScore]=useState(90),[level,setLevel]=useState<NonNullable<Settings['levelThreshold']>>('high');
  const [enabled,setEnabled]=useState<boolean|null>(null),[saving,setSaving]=useState(false),[error,setError]=useState('');
  useEffect(()=>{if(!visible)return;let active=true;void window.red.getImageRiskSettings().then(value=>{if(active){setEnabled(value.enabled);setScore(value.scoreThreshold??90);setLevel(value.levelThreshold??'high');setError('');}},cause=>{if(active)setError(errorText(cause));});return()=>{active=false;};},[visible]);
  async function change(value:boolean,nextScore=score,nextLevel=level){
    if(saving||busy)return;setSaving(true);setError('');
    try{const saved=await window.red.saveImageRiskSettings({enabled:value,scoreThreshold:nextScore,levelThreshold:nextLevel});setEnabled(saved.enabled);setScore(saved.scoreThreshold??90);setLevel(saved.levelThreshold??'high');window.dispatchEvent(new Event('image-risk-settings-changed'));}
    catch(cause){setError(errorText(cause));}finally{setSaving(false);}
  }
  return <div className="image-generation-other" aria-label="图片风险拦截设置">
    <h4>图片风险拦截</h4>
    <label className="image-generation-enable"><input type="checkbox" role="switch" aria-label="启用图片风险拦截" checked={enabled??true} disabled={busy||saving||enabled===null} onChange={event=>void change(event.target.checked)}/><span>{saving?'正在保存…':enabled===null?'正在读取…':enabled?'已开启':'已关闭'}</span></label>
    <label>风险分数阈值（严格大于）<input aria-label="风险分数阈值" type="number" min="0" max="100" step="0.1" value={Number.isNaN(score)?'':score} disabled={busy||saving||enabled===null} onChange={event=>setScore(event.target.valueAsNumber)} onBlur={()=>{if(Number.isFinite(score)&&score>=0&&score<=100)void change(enabled??true);else setError('风险分数须为 0–100');}}/></label>
    <label>风险等级阈值<select aria-label="风险等级阈值" value={level} disabled={busy||saving||enabled===null} onChange={event=>void change(enabled??true,score,event.target.value as typeof level)}><option value="low">low 及以上</option><option value="medium">medium 及以上</option><option value="high">high</option></select></label>
    <p className="settings-help">生成图阿里云检测：风险标签分数严格大于阈值，或实际等级达到阈值，任一条件触发异常。默认 &gt;90 或 high；medium 本身不拦截。置信度不是侵权概率，安全库相似度不当作风险分数。来源 AI 初筛独立保留明确风险处理。旧结果按当前设置解释，原结论保留。</p>
    <p className="settings-help">开启时检查来源商品与生成图片的 IP 风险。关闭后跳过风险检测和拦截，第一张图仍检查是否带字；其余图片不做文字复核。已有图片和历史检测结果保留。切换会自动保存，继续任务时生效。</p>
    {error&&<p className="workflow-warning" role="alert">{error}</p>}
  </div>;
}
