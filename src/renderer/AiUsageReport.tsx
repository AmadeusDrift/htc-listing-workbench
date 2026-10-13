import { useEffect,useState } from 'react';
import type { AiUsageReport as Report } from '../shared/ai-purpose-contracts';
import { AI_PURPOSE_LABELS } from '../shared/ai-purpose-contracts';
import { errorText } from './utils';
const usd=(value:number)=>'$'+value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:10});
export function AiUsageReport(){
  const today=new Date().toISOString().slice(0,10),[from,setFrom]=useState(today),[to,setTo]=useState(today),[report,setReport]=useState<Report|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function read(){setBusy(true);setError('');try{setReport(await window.red.getAiUsageReport({from,to}));}catch(cause){setError(errorText(cause));}finally{setBusy(false);}}
  useEffect(()=>{let active=true;setBusy(true);void window.red.getAiUsageReport({from:today,to:today}).then(value=>{if(active)setReport(value);}).catch(cause=>{if(active)setError(errorText(cause));}).finally(()=>{if(active)setBusy(false);});return()=>{active=false;};},[]);
  return <section className="ai-functions" aria-label="AI 用量明细" aria-busy={busy}><h4>用量与已报费用</h4>
    <div className="ai-function-controls"><label className="field"><span>开始日期（UTC）</span><input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label><label className="field"><span>结束日期（UTC）</span><input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label><button type="button" className="button secondary" disabled={busy||!from||!to||from>to} onClick={()=>void read()}>{busy?'正在读取…':'读取明细'}</button></div>
    {error&&<p className="workflow-warning" role="alert">{error}；上次读取结果仍保留。</p>}
    {report&&<><p className="settings-help">{report.from} 至 {report.to}（UTC） · 已登记调用 {report.calls} 次 · 已报费用 {usd(report.reportedCostUsd)} · {report.unknownCostCalls} 次费用未知</p><p className="settings-help">费用来自供应商回执，不含充值手续费，可能不含 BYOK 上游账单。没有报告费用的调用不会按零元计入总额。</p><div style={{overflowX:'auto'}}><table><thead><tr><th>日期</th><th>用途</th><th>渠道 / 型号</th><th>调用</th><th>已报 Token</th><th>费用</th></tr></thead><tbody>{report.rows.map((row,i)=><tr key={i}><td>{row.date}</td><td>{AI_PURPOSE_LABELS[row.purposeId as keyof typeof AI_PURPOSE_LABELS]??(row.purposeId==='image_generation'?'图像生成':'历史用途')}</td><td>{row.gateway}<br/>{row.model}</td><td>{row.calls}</td><td>{row.reportedTokens.toLocaleString()}</td><td>{row.totalCostUsd===null?usd(row.reportedCostUsd)+' 已报；另 '+row.unknownCostCalls+' 次未知':usd(row.totalCostUsd)}</td></tr>)}</tbody></table>{!report.rows.length&&<p className="settings-help">此日期范围没有已登记的调用。</p>}</div></>}
  </section>;
}
