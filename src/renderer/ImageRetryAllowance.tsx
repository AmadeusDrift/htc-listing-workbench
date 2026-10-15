import { useRef, useState } from 'react';
import { imageSlotAttemptLimit, type ImageWorkflowProgress } from '../shared/image-workflow-contracts';
import { errorText } from './utils';
export function ImageRetryAllowance({run,slot,active,onUpdated}:{run:ImageWorkflowProgress;slot:number;active:boolean;onUpdated:(run:ImageWorkflowProgress)=>void}){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),command=useRef<{requestId:string;grantCount:number;id:string}|null>(null);
 const state=run.retryAllowanceStatus?.find(s=>s.slot===slot),attempt=run.slots?.[slot-1]?.attempts.at(-1);
 if(!state||!attempt||run.slots?.[slot-1]?.status==='PASSED')return null;
 const add=async()=>{if(busy)return;if(command.current?.requestId!==attempt.requestId||command.current?.grantCount!==(run.retryAllowance?.grants.length??0))command.current={requestId:attempt.requestId,grantCount:run.retryAllowance?.grants.length??0,id:crypto.randomUUID()};setBusy(true);setError('');try{onUpdated(await window.red.addImageRetryAllowance({draftId:run.draftId,slot,requestId:attempt.requestId,commandId:command.current.id}));}catch(cause){setError(errorText(cause));}finally{setBusy(false);}};
 return <div className="image-retry-allowance">
  <p className="small-copy">追加次数不会提高金额上限；原费用和未知预留继续累计。</p>
  {state.automatic&&<p className="small-copy">符合历史一次性补额：点击继续任务时自动追加3次并接续。</p>}
  {state.manual&&<><p className="small-copy">当前{state.scope==='planning'?'规划':imageSlotAttemptLimit(run,slot)+'次生图'}额度已耗尽。追加后继续执行可能产生新费用，仍受预算限制；本按钮只补额。</p><button type="button" disabled={active||busy} onClick={()=>void add()}>{busy?'正在追加…':'手动追加3次'}</button></>}
  {!state.manual&&state.reason&&<p className="small-copy">{state.reason}</p>}
  {state.retainedAttempts&&<details><summary>备份后保留的尝试历史（未重新执行）</summary><ol>{state.retainedAttempts.map(a=><li key={a.requestId}>第{a.number}次 · {a.state} · {a.failureProof?.at??'原失败时间未记录'}<p>{a.error}</p><code>{a.requestId}</code></li>)}</ol></details>}
  {error&&<p role="alert">{error}</p>}
 </div>;
}
