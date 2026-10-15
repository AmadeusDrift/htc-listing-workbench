import {useEffect,useState} from 'react';
import type {AutomaticRoundSummary} from '../shared/automatic-listing-contracts';
import {errorText} from './utils';
export function AutomaticRoundPanel({taskId,commandPending}:{taskId:string;commandPending:boolean}){
 const [round,setRound]=useState<AutomaticRoundSummary|null>(null),[error,setError]=useState(''),[retry,setRetry]=useState(0),[open,setOpen]=useState(false);
 useEffect(()=>{let active=true;if(commandPending||!open)return;setError('');setRound(null);void window.red.getAutomaticCurrentRound?.(taskId).then(value=>{if(active)setRound(value);},cause=>{if(active)setError(errorText(cause));});return()=>{active=false;};},[taskId,commandPending,retry,open]);
 return <details className="workflow-notice" onToggle={event=>setOpen(event.currentTarget.open)}><summary>本轮费用与从头检查说明</summary><p>从头检查保留原SKU、有效草稿、字段和已通过图片，只补缺失步骤。本轮新增费用从0起算；历史真实费用、次数和未知请求预留不清空。</p>{round?<><p>{round.mode==='from-start'?'本轮从头检查':'本轮接续'}开始于 {new Date(round.startedAt).toLocaleString()}。</p><p>本轮已报告费用：{round.fees?`$${(round.fees.reportedUsdMicros/1_000_000).toFixed(6)}`:'尚未读取'}{round.fees?`；待确认请求 ${round.fees.pendingCalls} 个，费用未报告 ${round.fees.unknownCostCalls} 个。`:''}</p><p className="small-copy">仅统计本轮新发且可明确关联的原请求。回收旧请求不算新请求；旧未知请求仍占原费用预留。此处不是退款或总费用清零。</p></>:<p>展开后读取本轮记录；没有新一轮时，历史费用保留。</p>}<button type="button" className="text-button" disabled={commandPending} onClick={()=>setRetry(v=>v+1)}>刷新本轮费用</button>{error&&<p role="alert">{error}</p>}</details>;
}
