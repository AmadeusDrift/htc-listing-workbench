import {useEffect,useRef,useState} from 'react';
import type {SalesUnitAdoptionPreview,AmazonDraft} from '../shared/amazon-contracts';
import type {AutomaticListingTask,AutomaticSalesUnitPreview} from '../shared/automatic-listing-contracts';
import {salesPlatformPieces} from '../shared/source-quantity';
import {errorText} from './utils';

export interface TaskUnitScope {taskId:string;taskRevision:number;itemKey:string;onUpdated(task:AutomaticListingTask):void}
export function SalesUnitAdoptionPanel({draftId,draftRevision,initial,scope,unsaved=false,onDraftUpdated}:{draftId:string;draftRevision:number;initial:SalesUnitAdoptionPreview;scope?:TaskUnitScope;unsaved?:boolean;onDraftUpdated?(draft:AmazonDraft):void}){
 const [count,setCount]=useState(''),[basis,setBasis]=useState(''),[confirmed,setConfirmed]=useState(false),[proof,setProof]=useState<SalesUnitAdoptionPreview|null>(null),[taskProof,setTaskProof]=useState<AutomaticSalesUnitPreview|null>(null),[pending,setPending]=useState(''),[error,setError]=useState(''),[message,setMessage]=useState('');
 const ownerKey=JSON.stringify([draftId,scope?.taskId??null,scope?.itemKey??null]),proofKey=JSON.stringify([ownerKey,draftRevision,scope?.taskRevision??null,initial.token,unsaved]);
 const request=useRef({proofKey,epoch:0});if(request.current.proofKey!==proofKey)request.current={proofKey,epoch:request.current.epoch+1};
 useEffect(()=>{setCount('');setBasis('');setError('');setMessage('');},[ownerKey]);
 useEffect(()=>{setProof(null);setTaskProof(null);setConfirmed(false);setPending('');},[proofKey]);
 const valid=Number.isSafeInteger(Number(count))&&Number(count)>0&&Number(count)<=1_000_000&&basis.trim().length>0;
 const value=proof??initial,proposal=value.proposed;
 const reset=()=>{setProof(null);setTaskProof(null);setConfirmed(false);setError('');setMessage('');};
 async function inspect(){
  if(!valid||pending||unsaved)return;const epoch=request.current.epoch;setPending('preview');setError('');setMessage('');setConfirmed(false);
  try{
   const input={platformPieces:Number(count),basis:basis.trim()};
   if(scope){const p=await window.red.previewAutomaticSalesUnitAdoption({...input,taskId:scope.taskId,taskRevision:scope.taskRevision,itemKey:scope.itemKey});if(epoch!==request.current.epoch)return;setTaskProof(p);setProof(p.unitPreview);}
   else{const p=await window.red.previewAmazonSalesUnitAdoption({...input,id:draftId,revision:draftRevision});if(epoch!==request.current.epoch)return;setProof(p);}
  }catch(cause){if(epoch===request.current.epoch)setError(errorText(cause));}finally{if(epoch===request.current.epoch)setPending('');}
 }
 async function adopt(){
  if(!proof?.canApply||!confirmed||pending||unsaved)return;const epoch=request.current.epoch;setPending('adopt');setError('');
  try{
   const input={platformPieces:Number(count),basis:basis.trim(),confirmed:true as const};
   if(scope&&taskProof){const task=await window.red.adoptAutomaticSalesUnit({...input,taskId:scope.taskId,taskRevision:taskProof.taskRevision,itemKey:scope.itemKey,token:taskProof.token});if(epoch!==request.current.epoch)return;scope.onUpdated(task);}
   else if(!scope){const draft=await window.red.adoptAmazonSalesUnit({...input,id:draftId,revision:draftRevision,token:proof.token});if(epoch!==request.current.epoch)return;onDraftUpdated?.(draft);}
   else throw Error('原任务对照已失效，请重新检查');
   setMessage('已本地采用计量；原 SKU、费用和成功图片保留。请重新读取报价，核对后再自行继续。');setConfirmed(false);setProof(null);setTaskProof(null);
  }catch(cause){if(epoch===request.current.epoch)setError(errorText(cause));}finally{if(epoch===request.current.epoch)setPending('');}
 }
 return <fieldset className="listing-mapping-rows" aria-label="销售单位计量对照"><legend>销售单位与附件对照</legend>
  <p>历史配方保持可追溯。平台件数请按真实销售口径填写，附件数不作整套报价除数。</p>
  <dl className="quote-grid"><div><dt>旧成本 / 新成本</dt><dd>{value.previous.totalCostCny===null?'待确认':`¥${value.previous.totalCostCny} CNY`} / {proposal?.totalCostCny===null||!proposal?'待确认':`¥${proposal.totalCostCny} CNY`}</dd></div><div><dt>旧销售计量 / 新销售单位</dt><dd>{value.previous.totalPieces}（历史） / {proposal?`${proposal.totalPieces} ${proposal.components.some(c=>c.unitSemantics?.kind==='kit')?'整套':'件'}`:'待确认'}</dd></div><div><dt>旧平台件数 / 新平台件数</dt><dd>{salesPlatformPieces(value.previous)??'待确认'} / {proposal?salesPlatformPieces(proposal)??'待确认':'待确认'}</dd></div></dl>
  <p><strong>旧采购展开</strong>：{value.purchaseBefore}</p><p><strong>新采购展开</strong>：{value.purchaseAfter??'计价或销售单位尚未确认'}</p>
  <label className="field"><span>明确确认的平台销售件数</span><input type="number" min="1" max="1000000" step="1" value={count} disabled={!!pending||unsaved} onChange={event=>{setCount(event.target.value);reset();}}/></label>
  <label className="field"><span>计量确认依据</span><textarea value={basis} maxLength={2000} disabled={!!pending||unsaved} onChange={event=>{setBasis(event.target.value);reset();}}/></label>
  <button type="button" className="button secondary" disabled={!valid||!!pending||unsaved} onClick={()=>{void inspect();}}>{pending==='preview'?'正在检查计量…':'检查计量对照'}</button>
  {proof?.blockers.map(reason=><p key={reason} role="status">{reason}</p>)}
  <label className="listing-ai-choice"><input type="checkbox" checked={confirmed} disabled={!proof?.canApply||!!pending||unsaved} onChange={event=>setConfirmed(event.target.checked)}/>我确认采用当前计量对照，并保留原 SKU</label>
  <button type="button" className="button secondary" disabled={!proof?.canApply||!confirmed||!!pending||unsaved} onClick={()=>{void adopt();}}>{pending==='adopt'?'正在采用计量…':'明确采用计量'}</button>
  {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
  <p className="small-copy">采用仅保存本地计量与必要报价字段；不会自动继续任务、付费或发布。已有图片需按新计量复核，费用与原请求历史不清零。</p>
 </fieldset>;
}
