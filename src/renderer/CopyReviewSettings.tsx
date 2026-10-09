import { useEffect, useState } from 'react';
import { errorText } from './utils';

export function CopyReviewSettings({visible,busy}:{visible:boolean;busy:boolean}){
  const [enabled,setEnabled]=useState<boolean|null>(null),[saving,setSaving]=useState(false),[error,setError]=useState('');
  useEffect(()=>{if(!visible)return;let active=true;void window.red.getCopyReviewSettings().then(value=>{if(active){setEnabled(value.enabled);setError('');}},cause=>{if(active)setError(errorText(cause));});return()=>{active=false;};},[visible]);
  async function change(value:boolean){
    if(saving||busy)return;setSaving(true);setError('');
    try{const saved=await window.red.saveCopyReviewSettings({enabled:value});setEnabled(saved.enabled);window.dispatchEvent(new Event('copy-review-settings-changed'));}
    catch(cause){setError(errorText(cause));}finally{setSaving(false);}
  }
  return <div className="image-generation-other" aria-label="文案复核设置">
    <h4>文案复核</h4>
    <label className="image-generation-enable"><input type="checkbox" role="switch" aria-label="启用文案复核" checked={enabled??true} disabled={busy||saving||enabled===null} onChange={event=>void change(event.target.checked)}/><span>{saving?'正在保存…':enabled===null?'正在读取…':enabled?'已开启':'已关闭'}</span></label>
    <p className="settings-help">开启时独立复核生成文案，并在生图前复核当前商品文案。关闭后跳过这两项复核，仍生成文案、补齐必填字段并检查首图是否带字；不影响图片风险拦截开关。跳过复核不代表审核通过，历史复核结果保留。切换会自动保存，继续任务时生效。</p>
    {error&&<p className="workflow-warning" role="alert">{error}</p>}
  </div>;
}
