import { useEffect, useState } from 'react';
import { errorText } from './utils';

export function AppearanceReviewSettings({visible,busy}:{visible:boolean;busy:boolean}){
  const [enabled,setEnabled]=useState<boolean|null>(null),[saving,setSaving]=useState(false),[error,setError]=useState('');
  useEffect(()=>{if(!visible)return;let active=true;void window.red.getAppearanceReviewSettings().then(value=>{if(active){setEnabled(value.enabled);setError('');}},cause=>{if(active)setError(errorText(cause));});return()=>{active=false;};},[visible]);
  async function change(value:boolean){
    if(saving||busy)return;setSaving(true);setError('');
    try{const saved=await window.red.saveAppearanceReviewSettings({enabled:value});setEnabled(saved.enabled);window.dispatchEvent(new Event('copy-review-settings-changed'));}
    catch(cause){setError(errorText(cause));}finally{setSaving(false);}
  }
  return <div className="image-generation-other" aria-label="外观一致性复核设置">
    <h4>外观一致性复核</h4>
    <label className="image-generation-enable"><input type="checkbox" role="switch" aria-label="启用外观一致性复核" checked={enabled??true} disabled={busy||saving||enabled===null} onChange={event=>void change(event.target.checked)}/><span>{saving?'正在保存…':enabled===null?'正在读取…':enabled?'已开启':'已关闭 · 未执行外观复核'}</span></label>
    <p className="settings-help">对主图和全部详情图核对商品身份、颜色、数量与形状。关闭表示未执行外观复核，不代表通过；文案复核和风险拦截保持独立。切换自动保存，仅新建图片流程采用新设置；已有流程沿用保存的设置快照。</p>
    {error&&<p className="workflow-warning" role="alert">{error}</p>}
  </div>;
}
