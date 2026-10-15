import {useEffect,useRef,useState} from 'react';
import type {ImageGenerationSpendStatus,AiSpendStatus} from '../shared/ai-spend-contracts';
import {useFormGuard} from './FormGuard';
import {errorText} from './utils';

const usd=(value:number)=>{const n=BigInt(value),fraction=(n%1_000_000n).toString().padStart(6,'0').replace(/0+$/,'');return`${n/1_000_000n}${fraction?'.'+fraction:''}`;};
function Amounts({value}:{value:AiSpendStatus}){return <dl className="image-spend-amounts"><div><dt>已报告费用</dt><dd>USD {usd(value.reportedUsdMicros)}</dd></div><div><dt>未结费用预留</dt><dd>USD {usd(value.heldUsdMicros)}</dd></div><div><dt>剩余额度</dt><dd>{value.remainingUsdMicros===null?'不设金额上限':'USD '+usd(value.remainingUsdMicros)}</dd></div></dl>;}
export function ImageSpendSettings({visible,busy}:{visible:boolean;busy:boolean}){
 const [status,setStatus]=useState<ImageGenerationSpendStatus|null>(null),[unlimited,setUnlimited]=useState(true),[limit,setLimit]=useState(''),[loading,setLoading]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');const live=useRef(true),pending=useRef(false);
 const apply=(value:ImageGenerationSpendStatus)=>{setStatus(value);setUnlimited(value.daily.limitUsdMicros===null);setLimit(value.daily.limitUsdMicros===null?'':usd(value.daily.limitUsdMicros));};
 const dirty=!!status&&(unlimited!==(status.daily.limitUsdMicros===null)||!unlimited&&limit!==usd(status.daily.limitUsdMicros??0));
 useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
 useEffect(()=>{if(!visible||pending.current||dirty)return;pending.current=true;setLoading(true);setError('');void Promise.resolve().then(()=>window.red.getImageGenerationSpendStatus()).then(value=>{if(live.current)apply(value);},cause=>{if(live.current)setError(errorText(cause));}).finally(()=>{pending.current=false;if(live.current)setLoading(false);});},[visible]);
 const disabled=busy||loading||saving||!visible;
 async function refresh(){if(disabled||pending.current||dirty)return;pending.current=true;setLoading(true);setError('');try{const value=await window.red.getImageGenerationSpendStatus();if(live.current)apply(value);}catch(cause){if(live.current)setError(errorText(cause));}finally{pending.current=false;if(live.current)setLoading(false);}}
 async function save(){if(disabled||pending.current||!status)return false;pending.current=true;setSaving(true);setError('');setNotice('');try{const value=await window.red.setImageGenerationDailySpendLimit({limitUsd:unlimited?null:limit,expectedUpdatedAt:status.daily.policyUpdatedAt});if(live.current){apply(value);setNotice('日金额上限已保存；原费用和未知预留保留。');}return true;}catch(cause){if(live.current)setError(errorText(cause));return false;}finally{pending.current=false;if(live.current)setSaving(false);}}
 const discard=()=>{if(status)apply(status);setError('');setNotice('');};useFormGuard({dirty:()=>dirty,save,discard});
 return <form className="image-generation-other image-spend-settings" aria-label="生图金额预算" aria-busy={loading||saving} onSubmit={event=>{event.preventDefault();void save();}}>
  <div className="credential-heading"><h4>生图金额预算 · USD</h4><button className="button secondary" type="button" disabled={disabled||dirty} onClick={()=>void refresh()}>刷新金额记录</button></div>
  <p className="settings-help">日金额按 UTC 计算；旧日未结请求继续占预留。已有调用次数和图位尝试限制独立保留。</p>
  <label className="image-generation-enable"><input type="checkbox" aria-label="不设生图日金额上限" checked={unlimited} disabled={disabled||!status} onChange={event=>setUnlimited(event.target.checked)}/><span>不设普通生图日金额上限</span></label>
  <label className="field"><span>生图日金额上限（USD）</span><input aria-label="生图日金额上限（USD）" inputMode="decimal" value={limit} disabled={disabled||!status||unlimited} required={!unlimited} pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?" onChange={event=>setLimit(event.target.value)}/><small>最多6位小数。0表示停止新生图付费请求；不会清除已用费用或预留。</small></label>
  <div className="credential-actions"><button className="button" type="submit" disabled={disabled||!dirty}>保存日金额上限</button><button className="button secondary" type="button" disabled={disabled||!dirty} onClick={discard}>放弃金额修改</button></div>
  {status?<><Amounts value={status.daily}/><p className="settings-help">未知请求：{status.daily.unknownCalls}；在途请求：{status.daily.pendingCalls}。{status.daily.unboundedCalls>0&&<>其中{status.daily.unboundedCalls}次费用没有可靠上界，保留未知负债。</>}</p><h4>受控验收累计上限：USD 5</h4><p className="settings-help">{status.controlledRunStatus==='not-registered'?'未登记受控会话':status.controlledRunStatus==='ACTIVE'?'受控会话已授权':'受控会话已暂停'}。整个验收及修复循环累计，不随重启、日期或连接变更重置。</p><Amounts value={status.controlledLifetime}/>{(status.daily.anomaly||status.controlledLifetime.anomaly)&&<p className="workflow-warning" role="alert">已报告费用超过原预留上界；所属有限预算停止新增付费请求，原账保留。</p>}</>:<p className="settings-help">{loading?'正在读取本地金额记录…':'金额记录尚未读取。'}</p>}
  <p className="settings-help">费用上界尚未检查；每次请求前核验。启用金额上限或受控验收时，无法可靠预留则停止付费请求。打开本页或刷新只读本地记录。</p>
  {error&&<p className="workflow-warning" role="alert">{error}</p>}{notice&&<p className="workflow-notice" role="status">{notice}</p>}
 </form>;
}
