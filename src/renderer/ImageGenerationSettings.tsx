import { useFormGuard } from './FormGuard';
import { useEffect,useRef,useState } from 'react';
import { ImagePlus,RefreshCw,ArrowRight } from 'lucide-react';
import { DEFAULT_OPENROUTER_IMAGE_MODEL,OPENROUTER_IMAGE_MODELS } from '../shared/image-generation-contracts';
import type { ImageGenerationConnection,ImageGenerationSize,ImageGenerationQuality } from '../shared/image-generation-contracts';
import { ImageRiskSettings } from './ImageRiskSettings';
import { AppearanceReviewSettings } from './AppearanceReviewSettings';
import { CopyReviewSettings } from './CopyReviewSettings';
import { errorText,formatDate } from './utils';
import './image-generation-settings.css';

export function ImageGenerationSettings({visible,busy,onAiSettings}:{visible:boolean;busy:boolean;onAiSettings:()=>void}){
  const [connection,setConnection]=useState<ImageGenerationConnection|null>(null);
  const [model,setModel]=useState<string>(DEFAULT_OPENROUTER_IMAGE_MODEL),[size,setSize]=useState<ImageGenerationSize>('auto'),[quality,setQuality]=useState<ImageGenerationQuality>('auto');
  const [enabled,setEnabled]=useState(false),[apiKey,setApiKey]=useState(''),[pending,setPending]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const mounted=useRef(true), actionPending=useRef(false);
  const apply=(value:ImageGenerationConnection)=>{setConnection(value);setModel(value.model);setSize(value.size);setQuality(value.quality);setEnabled(value.enabled);};
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{
    let cancelled=false;setApiKey('');setLoading(false);if(!visible||actionPending.current)return;
    setLoading(true);setError('');void window.red.getImageGenerationConnection().then(value=>{if(!cancelled&&!actionPending.current)apply(value);}).catch(cause=>{if(!cancelled)setError(errorText(cause));}).finally(()=>{if(!cancelled)setLoading(false);});
    return()=>{cancelled=true;};
  },[visible]);
  useEffect(()=>{const clear=()=>{if(document.hidden)setApiKey('');};document.addEventListener('visibilitychange',clear);return()=>document.removeEventListener('visibilitychange',clear);},[]);
  const dirty=!!connection&&(model!==connection.model||size!==connection.size||quality!==connection.quality||enabled!==connection.enabled||!!apiKey);
  const disabled=busy||pending||loading||!visible;
  async function act(work:()=>Promise<ImageGenerationConnection>,message:string){
    if(disabled||actionPending.current)return false;actionPending.current=true;setPending(true);setError('');setNotice('');
    try{const value=await work();if(mounted.current){apply(value);setApiKey('');setNotice(message);}return true;}
    catch(cause){if(mounted.current)setError(errorText(cause));return false;}
    finally{actionPending.current=false;if(mounted.current)setPending(false);}
  }
  const save = () => act(()=>window.red.saveImageGenerationConnection({provider:'openrouter',model,size,quality,enabled,...(apiKey.trim()?{apiKey:apiKey.trim()}:{})}),'生图配置已保存，没有生成图片。');
  useFormGuard({dirty:()=>dirty,save,discard:()=>{if(connection)apply(connection);setApiKey('');setError('');}});
  return <section className="settings-section image-generation-settings" aria-busy={pending||loading}>
    <div className="settings-section-title"><ImagePlus size={20} aria-hidden="true"/><div><h3>图片与生图</h3><p>OpenRouter 图像生成与独立复核设置。</p></div><button type="button" className="button secondary" disabled={disabled||dirty} onClick={()=>void act(()=>window.red.getImageGenerationConnection(),'状态已刷新')}><RefreshCw size={15}/>刷新状态</button></div>
    <ImageRiskSettings visible={visible} busy={busy}/><CopyReviewSettings visible={visible} busy={busy}/><AppearanceReviewSettings visible={visible} busy={busy}/>
    <form className="credential-form image-generation-form" aria-label="OpenRouter 生图连接配置" autoComplete="off" onSubmit={event=>{event.preventDefault();void save();}}>
      <div className="credential-heading"><h4>OpenRouter 图像生成</h4><span role="status">{pending||loading?'正在处理…':!connection?'状态未读取':!connection.configured?'未配置':connection.enabled?'已启用':'已保存 · 未启用'}</span></div>
      <div className="image-generation-endpoint"><span>生图接口</span><code>https://openrouter.ai/api/v1/images</code></div>
      <label className="field"><span>OpenRouter API Key</span><input aria-label="OpenRouter API Key" type="password" autoComplete="new-password" value={apiKey} disabled={disabled} placeholder={connection?.configured?'留空保留已保存密钥':'填写 OpenRouter 密钥'} onChange={event=>setApiKey(event.target.value)}/><small>与文案、Decisions 共用同一 OpenRouter 连接，只需填写一次。历史直连和中转密钥不会迁移。</small></label>
      <div className="image-generation-fields">
        <label className="field"><span>生图模型</span><select aria-label="生图模型" value={model} disabled={disabled} onChange={event=>setModel(event.target.value)}>{OPENROUTER_IMAGE_MODELS.map(id=><option key={id} value={id}>{id}</option>)}</select></label>
        <label className="field"><span>默认尺寸</span><select aria-label="默认尺寸" value={size} disabled={disabled} onChange={event=>setSize(event.target.value as ImageGenerationSize)}>{['auto','1024x1024','1536x1024','1024x1536'].map(value=><option key={value} value={value}>{value==='auto'?'自动':value.replace('x',' × ')}</option>)}</select></label>
        <label className="field"><span>默认质量</span><select aria-label="默认质量" value={quality} disabled={disabled} onChange={event=>setQuality(event.target.value as ImageGenerationQuality)}>{[['auto','模型默认'],['low','低'],['medium','中'],['high','高']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      </div>
      <div className="image-generation-enable"><label><input type="checkbox" checked={enabled} disabled={disabled} onChange={event=>setEnabled(event.target.checked)}/>启用生图接口</label></div>
      <div className="credential-actions"><button className="button" type="submit" disabled={disabled||!dirty||(!connection?.configured&&!apiKey.trim())}>保存配置</button><button className="button secondary" type="button" disabled={disabled||dirty||!connection?.configured} onClick={()=>void act(()=>window.red.checkImageGenerationConnection(),'模型目录可访问，真实生图权限、费用和质量仍待验证。')}>检查模型访问</button><button className="button secondary" type="button" disabled={disabled||!connection?.configured} onClick={()=>void act(()=>window.red.disconnectImageGenerationConnection(),'OpenRouter 连接已断开，文案、Decisions 和生图需重新配置；历史成果保留。')}>断开 OpenRouter</button></div>
      {dirty&&<p className="image-generation-unsaved" role="status">有未保存的更改。</p>}
      {busy&&<p className="settings-help">任务进行时暂不能修改连接。</p>}
      <p className="settings-help">生图按普通接口调用，当前不支持 Batch。保存和打开本页不会生成图片。{connection?.checkedAt&&<>最近检查：{formatDate(connection.checkedAt)}</>}</p>
      {error&&<p className="workflow-warning" role="alert">{error}</p>}{notice&&<p className="workflow-notice" role="status">{notice}</p>}
    </form>
    <div className="image-generation-other"><h4>自动七图规则</h4><p className="settings-help">每个销售 SKU 七张图：第一张为无字场景主图，其余根据可靠商品资料表达卖点。自动补填尺寸不作为图片实测依据。方案与提示词使用该用途已配置的模型。</p><button type="button" className="button secondary" onClick={onAiSettings}><ArrowRight size={15}/>逐用途模型与思考设置</button></div>
  </section>;
}
