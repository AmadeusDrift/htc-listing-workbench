import {useEffect,useState} from 'react';
import type {AmazonDraft} from '../shared/amazon-contracts';
import type {ListingCorrection,ListingCorrectionState} from '../shared/listing-correction-contracts';
import type {TaskRunner} from './amazon-ui';
import {errorText} from './utils';
const labels:Record<ListingCorrectionState,string>={PREPARED:'待验证预览',READY:'可确认发送',SENDING:'已记录发送意图',ACCEPTED:'已接受，待核对',VERIFIED:'目标修正已核实',REJECTED:'已拒绝',STALE:'准备已失效',CANCELLED:'已取消',UNKNOWN:'结果未知，禁止重发'};
export function ListingCorrectionPanel({draft,busy,run,onDraft}:{draft:AmazonDraft;busy:boolean;run:TaskRunner;onDraft:(d:AmazonDraft)=>void}){
 const [rows,setRows]=useState<ListingCorrection[]>([]),[error,setError]=useState('');
 useEffect(()=>{let alive=true;setRows([]);setError('');void window.red.listAmazonCorrections(draft.id).then(r=>{if(alive)setRows(r);}).catch(e=>{if(alive)setError(errorText(e));});return()=>{alive=false;};},[draft.id]);
 const current=rows[0],ref=current?{id:current.id,revision:current.revision,patchHash:current.patchHash}:null;
 const act=(name:string,action:()=>Promise<ListingCorrection|null>)=>void run(name,async()=>{try{const value=await action();if(value)setRows(await window.red.listAmazonCorrections(draft.id));setError('');}catch(e){setRows(await window.red.listAmazonCorrections(draft.id));throw e;}});
 const submitted=!!draft.submittedAt,canPrepare=!current||['REJECTED','STALE','CANCELLED','VERIFIED'].includes(current.state);
 return <div className="listing-publish"><div><h4>修正原 SKU</h4><p>{submitted?'支持已核实独立 SKU 包装自引用、固定危险品声明和确定枚举格式。先核对并验证，点击继续确认修正范围；同一问题最多两轮，无变化不重发。':'有精确旧 AI 采纳依据时，可局部纠正未提交草稿的包装自引用。'}</p>
  {error&&<p role="alert">{error}</p>}
  {current&&<><p><strong>{labels[current.state]}</strong> · {current.message}</p><p>原 SKU：{current.sku} · {current.marketplaceId} · {current.productType}</p><p>类型依据：{current.typeEvidence}</p><p>本地完整规则校验基于原可信提交；当前回读仅作差异基线，最终以修正验证预览为准。</p>{!!current.remoteLocalIssues.length&&<details><summary>回读属性的本地诊断（未将缺失字段补入 PATCH）</summary><pre>{JSON.stringify(current.remoteLocalIssues,null,2)}</pre></details>}
   <details open><summary>本次差异</summary><pre>{JSON.stringify({轮次:current.round??1,依据:current.evidence??[],字段差异:(current.scope??["package_contains_sku"]).map(field=>({字段:field,修正前:current.before[field]??null,修正后:current.after[field]??null})),补丁:current.request.patches},null,2)}</pre></details>
   {!!current.remainingIssues.length&&<details open><summary>仍需处理的平台问题（关系已消除不代表可售）</summary><pre>{JSON.stringify(current.remainingIssues,null,2)}</pre></details>}
   {rows.length>1&&<details><summary>历史修正案（{rows.length-1}）</summary>{rows.slice(1).map(r=><div key={r.id}>{labels[r.state]} · 第 {r.round??1} 轮 · {r.createdAt} · {r.message}<details><summary>冻结请求与平台结果</summary><pre>{JSON.stringify({request:r.request,response:r.response,readback:r.readback},null,2)}</pre></details></div>)}</details>}</>}
 </div><div className="workflow-actions">
 {!submitted&&<button type="button" className="button secondary" disabled={busy} onClick={()=>{void run('正在核对旧采纳并纠正本地关系…',async()=>onDraft(await window.red.correctAmazonSelfRelation({id:draft.id,revision:draft.revision})));}}>纠正未提交自引用</button>}
 {submitted&&canPrepare&&<button type="button" className="button secondary" disabled={busy} onClick={()=>act('正在读取原 SKU 并准备修正…',()=>window.red.prepareAmazonCorrection({id:draft.id,revision:draft.revision}))}>准备原 SKU 修正</button>}
 {current?.state==='PREPARED'&&<button type="button" className="button secondary" disabled={busy} onClick={()=>act('正在执行修正验证预览…',()=>window.red.previewAmazonCorrection(ref!))}>验证修正预览</button>}
 {current&&['PREPARED','READY'].includes(current.state)&&<button type="button" className="button primary" disabled={busy} onClick={()=>act('正在确认并发送原 SKU 修正…',()=>window.red.sendAmazonCorrection(ref!))}>继续并确认修正范围</button>}
 {current&&['ACCEPTED','UNKNOWN'].includes(current.state)&&<button type="button" className="button secondary" disabled={busy} onClick={()=>act('正在核对原 SKU 修正结果…',()=>window.red.readAmazonCorrection(ref!))}>核对修正结果</button>}
 {current&&['PREPARED','READY'].includes(current.state)&&<button type="button" className="button secondary" disabled={busy} onClick={()=>act('正在取消未发送修正…',()=>window.red.cancelAmazonCorrection(ref!))}>取消此案</button>}
 </div></div>;
}
