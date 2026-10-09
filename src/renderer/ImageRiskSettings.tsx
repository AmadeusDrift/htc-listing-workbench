import { useEffect, useState } from 'react';
import { errorText } from './utils';

export function ImageRiskSettings({visible,busy}:{visible:boolean;busy:boolean}){
  const [enabled,setEnabled]=useState<boolean|null>(null),[saving,setSaving]=useState(false),[error,setError]=useState('');
  useEffect(()=>{if(!visible)return;let active=true;void window.red.getImageRiskSettings().then(value=>{if(active){setEnabled(value.enabled);setError('');}},cause=>{if(active)setError(errorText(cause));});return()=>{active=false;};},[visible]);
  async function change(value:boolean){
    if(saving||busy)return;setSaving(true);setError('');
    try{const saved=await window.red.saveImageRiskSettings({enabled:value});setEnabled(saved.enabled);window.dispatchEvent(new Event('image-risk-settings-changed'));}
    catch(cause){setError(errorText(cause));}finally{setSaving(false);}
  }
  return <div className="image-generation-other" aria-label="图片风险拦截设置">
    <h4>图片风险拦截</h4>
    <label className="image-generation-enable"><input type="checkbox" role="switch" aria-label="启用图片风险拦截" checked={enabled??true} disabled={busy||saving||enabled===null} onChange={event=>void change(event.target.checked)}/><span>{saving?'正在保存…':enabled===null?'正在读取…':enabled?'已开启':'已关闭'}</span></label>
    <p className="settings-help">开启时检查来源商品与生成图片的 IP 风险。关闭后跳过风险检测和拦截，第一张图仍检查是否带字；其余图片不做文字复核。已有图片和历史检测结果保留。切换会自动保存，继续任务时生效。</p>
    {error&&<p className="workflow-warning" role="alert">{error}</p>}
  </div>;
}
