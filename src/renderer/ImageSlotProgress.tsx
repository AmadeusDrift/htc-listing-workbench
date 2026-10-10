import { presentRejection } from '../shared/rejection-presentation';
import { useEffect, useState } from 'react';
import type { ImageWorkflowProgress, ImageWorkflowSlot } from '../shared/image-workflow-contracts';
import { errorText } from './utils';
import { ImageSlotPreview } from './ImageSlotPreview';
import './image-slot-progress.css';

const labels:Record<ImageWorkflowSlot['status'],string>={PENDING:'待处理',RUNNING:'处理中',PASSED:'已通过',FAILED:'待处理异常',BLOCKED:'IP 风险阻断',UNKNOWN:'等待核对结果'};
export function ImageSlotProgress({draftId,revision,active,sku,color,defaultExpanded=true}:{draftId:string;revision:string;active:boolean;sku?:string;color?:string;defaultExpanded?:boolean}){
  const [snapshot,setSnapshot]=useState<{draftId:string;run:ImageWorkflowProgress|null}|null>(null),[error,setError]=useState(''),[retrying,setRetrying]=useState(false),[notice,setNotice]=useState('');
  const [expanded,setExpanded]=useState(defaultExpanded||active);
  const run=snapshot?.draftId===draftId?snapshot.run:null;
  const setRun=(value:ImageWorkflowProgress|null)=>setSnapshot({draftId,run:value});
  useEffect(()=>{if(active)setExpanded(true);},[active]);
  async function retryUnknown(slot:ImageWorkflowSlot){
    const attempt=slot.attempts.at(-1);if(!attempt||active||retrying)return;
    setRetrying(true);setNotice('');
    try{setRun(await window.red.approveUnknownImageRetry({draftId,slot:slot.index,requestId:attempt.requestId}));setError('');setNotice('已记录重试选择，点击“继续任务”后处理；其他图片保留。');}catch(cause){setNotice(errorText(cause));}finally{setRetrying(false);}
  }
  useEffect(()=>{
    let current=true,timer:ReturnType<typeof setTimeout>|undefined;
    const read=async()=>{try{const value=await window.red.getAutomaticProductProgress(draftId);if(current){setRun(value);setError('');}}catch(cause){if(current)setError(errorText(cause));}finally{if(current&&active)timer=setTimeout(()=>void read(),2000);}};
    void read();return()=>{current=false;if(timer)clearTimeout(timer);};
  },[draftId,revision,active]);
  if(error)return <p className="small-copy" role="status">图片进度暂不可读：{error}</p>;
  if(!run)return null;
  const unknown=run.resultUnknown===true||run.slots?.some(s=>s.status==='UNKNOWN'||s.attempts.some(a=>['UNKNOWN','GENERATING'].includes(a.state)));
  const failure=unknown||run.error||run.rejection?<p className="workflow-warning" role="status">{presentRejection(run.rejection?.code,unknown)}</p>:null;
  if(!run.slots)return <>{failure}<p className="small-copy">历史单图流程 · 新自动准备需要七张通过审核的图片。</p></>;
  const approved=run.slots.filter(slot=>slot.status==='PASSED').length;
  return <details className="image-slot-progress" open={expanded} onToggle={event=>setExpanded(event.currentTarget.open)}>
    <summary>图片通过 {approved} / 7 · 已用 {run.attempt} 次尝试</summary>
    {failure}
    {expanded&&<>
    <p className="image-slot-context">{[color,sku||run.sku].filter(Boolean).join(' · ')}<span>点击图片查看大图</span></p>
    {run.riskInterceptionEnabled===false&&<p className="small-copy">本套图片关闭了风险拦截；只对首图检查无字，未将跳过风险检测记为通过。</p>}
    {run.copyReviewEnabled===false&&<p className="small-copy">本套图片关闭了文案复核；跳过生成文案的独立复核与生图前文案复核，仍补齐必填字段并检查首图无字。跳过不代表审核通过。</p>}
    {notice&&<p className="small-copy" role="status">{notice}</p>}
    <p className="small-copy">先规划整套七图：无字场景主图、单图单卖点；有可靠尺寸时安排一张尺寸图，卖点不足以场景图补齐。每张最多三次尝试，已通过图片保留。</p>
    <ol className="image-slot-grid">{run.slots.map(slot=>{const plan=run.setPlan?.slots.find(value=>value.index===slot.index),title=plan?({main_scene:'场景主图',selling_point:'卖点图',dimensions:'尺寸图',scene:'场景图'}[plan.role]):slot.index===1?'主图':`详情 ${slot.index-1}`;return <li key={slot.index} data-state={slot.status}>
      <div className="image-slot-heading"><strong>{slot.index}. {title}</strong>{slot.index===1&&<span>当前 SKU 主图</span>}</div>
      <ImageSlotPreview key={`${draftId}:${slot.status==='PASSED'?slot.approvedAssetId:'candidate'}:${slot.attempts.findLast(attempt=>attempt.candidateId)?.candidateId??''}`} draftId={draftId} slot={slot} sku={sku||run.sku} title={title}/>
      {plan&&<small>{plan.focus}</small>}<span>{labels[slot.status]}</span><small>{slot.attempts.length} / {run.maxAttempts} 次</small>{slot.error&&<p>{presentRejection(run.rejection?.slot===slot.index?run.rejection.code:undefined,slot.status==='UNKNOWN'||slot.attempts.at(-1)?.state==='UNKNOWN')}</p>}
      {slot.attempts.at(-1)?.state==='UNKNOWN'&&<><p>上次请求结果未知。重新生成可能再次计费；会先核对本地是否已有结果。</p><button type="button" className="button secondary" disabled={active||retrying||slot.attempts.length>=run.maxAttempts} title={active?'任务仍在运行':retrying?'正在核对已有请求':slot.attempts.length>=run.maxAttempts?'已达到该位置尝试上限':undefined} onClick={()=>void retryUnknown(slot)}>{retrying?'正在核对…':'确认重新生成（可能重复计费）'}</button></>}
    </li>})}</ol>
    </>}
  </details>;
}
