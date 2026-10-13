import { presentRejection } from '../shared/rejection-presentation';
import { useEffect, useState } from 'react';
import type { AiResult } from '../shared/ai-contracts';
import type { AmazonDraft, JsonValue } from '../shared/amazon-contracts';
import type { CandidateField, ListingAiApi } from '../shared/listing-ai-contracts';
import type { TaskRunner } from './amazon-ui';
import { listingStateLabels } from './amazon-ui';
import { errorText } from './utils';

const labels: Record<CandidateField,string> = { item_name:'标题', bullet_point:'五点描述', product_description:'商品描述', generic_keyword:'搜索关键词', material:'材质', color:'颜色', item_shape:'形状', care_instructions:'清洗说明', operation_mode:'工作方式', included_components:'包含配件', special_feature:'商品特点', fabric_type:'面料成分', theme:'主题', subject_character:'主体角色', blade:'刀刃材质', target_audience:'适用人群',item_firmness_description:'软硬度',age_range_description:'年龄范围',is_heat_sensitive:'是否热敏',power_source_type:'动力来源',material_feature:'材料特性',is_expiration_dated_product:'是否有保质期',item_form:'商品形态',dental_floss_type:'牙线类型',flavor:'口味',contains_liquid_contents:'是否含液体',scent:'香型',specific_uses_for_product:'商品用途',surface_recommendation:'适用表面',closure:'闭合方式',department:'适用部门',target_gender:'适用性别',ingredients:'成分' };
function textValue(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return '尚未填写';
  if (Array.isArray(value)) return value.map(v => typeof v === 'object' && v && !Array.isArray(v) ? String(v.value ?? JSON.stringify(v)) : String(v)).join('\n');
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
export function ListingAiPanel({draft,disabled,dirty,run,onAdopt}: {draft:AmazonDraft;disabled:boolean;dirty:boolean;run:TaskRunner;onAdopt:(draft:AmazonDraft)=>void}) {
  const [results,setResults]=useState<AiResult[]>([]), [suggestionId,setSuggestionId]=useState(''), [selected,setSelected]=useState<CandidateField[]>([]), [notice,setNotice]=useState(''), [pending,setPending]=useState(false), [cancelling,setCancelling]=useState(false);
  const [completion,setCompletion]=useState<Awaited<ReturnType<ListingAiApi['completeAmazonFields']>>|null>(null);
  useEffect(()=>{setCompletion(null);},[draft.id]);
  useEffect(()=>{let live=true;setResults([]);setSuggestionId('');setSelected([]);setNotice('');
    void window.red.listAiResults(draft.productId).then(rows=>{if(!live)return;const own=rows.filter(r=>r.listingContext?.draftId===draft.id).reverse();setResults(own);setSuggestionId(own.find(r=>r.output.kind==='amazon-fields'&&!r.fieldGroupPart)?.id??'');}).catch(e=>{if(live)setNotice(errorText(e));});return()=>{live=false;};
  },[draft.id,draft.revision,draft.productId]);
  const suggestions=results.filter(r=>r.output.kind==='amazon-fields'&&!r.fieldGroupPart);
  const suggestion=suggestions.find(r=>r.id===suggestionId), output=suggestion?.output.kind==='amazon-fields'?suggestion.output:null;
  const review=results.find(r=>r.output.kind==='amazon-fields-review'&&r.sourceResultIds[0]===suggestionId), report=review?.output.kind==='amazon-fields-review'?review.output:null;
  const stale=!!suggestion&&suggestion.listingContext?.draftRevision!==draft.revision;
  const reviewBlocked=!!report&&report.verdict!=='PASS';
  const reviewRequired=!review&&suggestion?.listingContext?.policyVersion!=='haul-us-copy-2026-10-07-v2';
  const reference={draftId:draft.id,draftRevision:draft.revision};
  const blocked=disabled||dirty||pending;
  const blockedReason=disabled?'当前草稿操作不可用':dirty?'请先保存草稿':pending?'当前字段操作正在进行':undefined;
  async function act(kind:'complete'|'generate'|'review'|'adopt') {
    if(blocked)return;
    setPending(true);setNotice('');
    try {
      if(kind==='complete'){
        setCompletion(null);
        const completed=await run('正在按规则填报并运行预览…',()=>window.red.completeAmazonFields(reference));
        if(completed){setCompletion(completed);onAdopt(completed.draft);}
        else {
          try {const current=(await window.red.listAmazonDrafts(draft.productId)).find(item=>item.id===draft.id);if(current){onAdopt(current);setNotice('处理已停止，当前显示已保存的草稿进度。');}}
          catch(error){setNotice(`处理后的草稿读取失败：${errorText(error)}`);}
        }
        return;
      }
      if(kind==='adopt'){
        if(!suggestion||stale||reviewBlocked||reviewRequired||!selected.length)return;
        const saved=await run('正在写入选中字段并校验…',()=>window.red.adoptAmazonFields({...reference,suggestionResultId:suggestion.id,reviewResultId:review?.id??null,fields:selected}));
        if(saved){onAdopt(saved);setNotice('已写入选中字段，并完成本地检查。请继续处理待补字段。');}return;
      }
      const result=await run(kind==='generate'?'正在按用途配置生成英文字段建议…':'正在按复核配置核对事实…',()=>kind==='generate'?window.red.suggestAmazonFields(reference):window.red.reviewAmazonFields({...reference,suggestionResultId:suggestionId}));
      if(result){setResults(rows=>[result,...rows]);if(result.output.kind==='amazon-fields'){setSuggestionId(result.id);setSelected([]);}else setNotice(result.output.kind==='amazon-fields-review'&&result.output.verdict==='PASS'?'复核通过，请核对差异并选择要采纳的字段。':'复核发现问题，请查看下方说明。');}
    } finally {setPending(false);setCancelling(false);}
  }
  async function cancel() {
    if(cancelling)return;setCancelling(true);
    try {const result=await window.red.cancelAmazonFields(draft.id);setNotice(result.cancelled?'已请求取消处理，已完成的写入和调用记录仍保留。':'当前没有可取消的请求。');}
    catch(error){setNotice(errorText(error));}
    finally {setCancelling(false);}
  }
  return <section className="listing-ai-panel" aria-label="AI 上架字段辅助">
    <div className="section-heading"><div><h4>规则填报与预览</h4><p>先按已保存规则填写并预览，再按返回问题补全文案。独立复核可按需要运行。</p></div></div>
    <p className="small-copy">{draft.listingProgram==='haul'?'Haul 低价商城':'标准商城'} · {draft.schema.productType} · 美国英语 · 标题 75 字符 / 五点 5 条 / 描述 500 字符</p>
    {dirty&&<p className="workflow-warning">请先保存上架草稿，再运行填报预览或采纳建议。</p>}
    {draft.mode==='demo'&&<p className="small-copy">本地演示的预览结果为模拟数据；需要生成文案时仍会调用各用途已配置的模型，计入用量。</p>}
    <div className="workflow-actions"><button type="button" className="button primary" disabled={blocked} title={blockedReason} onClick={()=>void act('complete')}>规则填报并预览</button>{pending&&<button type="button" className="button secondary" disabled={cancelling} onClick={()=>void cancel()}>{cancelling?'正在取消…':'取消处理'}</button>}</div>
    {completion&&<div className={completion.remaining.length?'workflow-warning':'workflow-notice'} role="status">
      <div><strong>{completion.draft.revision===draft.revision?'处理结果':'上次处理结果'}：{completion.draft.mode==='demo'?'演示 · ':''}{listingStateLabels[completion.draft.state]}</strong>
        <p>AI 调用 {completion.aiCalls} 次 · {completion.draft.mode==='demo'?'演示':'Amazon 验证'}预览 {completion.previewAttempts} 次 · 草稿修订 {completion.draft.revision}</p>
        {!!completion.rejections?.length&&<ul>{completion.rejections.flatMap(r=>r.details.entries.map(e=><li key={r.resultId+e.field}>{labels[e.field]}：{presentRejection(e.code)}</li>))}</ul>}
        {completion.remaining.length?<><p>仍需处理：</p><ul>{completion.remaining.map((message,index)=><li key={index}>{message}</li>)}</ul></>:<p>本次流程没有返回待处理项，请继续核对草稿和预览记录。</p>}
      </div>
    </div>}
    {draft.businessRules&&<div className="settings-subsection">
      <h4>规则填报记录 · 规则修订 {draft.businessRules.revision}</h4>
      {!!draft.businessRules.notices.length&&<div className="workflow-warning" role="alert"><ul>{draft.businessRules.notices.map((message,index)=><li key={index}>{message}</li>)}</ul></div>}
      {draft.businessRules.quote&&<div>
        <strong>规则报价（本地估算）</strong><p className="small-copy">按已保存费表和包装参数计算；每套 {draft.businessRules.bundleQuantity} 件，结果仍需结合实际包装和预览核对。</p>
        <dl className="connection-values">
          <div><dt>销售价</dt><dd>${draft.businessRules.quote.price.toFixed(2)} USD</dd></div>
          <div><dt>最低估算价</dt><dd>${draft.businessRules.quote.minimum.toFixed(2)} USD</dd></div>
          <div><dt>估算 ROI</dt><dd>{(draft.businessRules.quote.roi*100).toFixed(1)}%</dd></div>
          <div><dt>成本与包装投入</dt><dd>¥{draft.businessRules.quote.upfrontCny.toFixed(2)} CNY</dd></div>
          <div><dt>配送费 / 佣金</dt><dd>${draft.businessRules.quote.deliveryFee.toFixed(2)} / ${draft.businessRules.quote.commission.toFixed(2)} USD</dd></div>
          <div><dt>抛重 / 计费重量</dt><dd>{draft.businessRules.quote.dimensionalWeightGrams.toFixed(1)} / {draft.businessRules.quote.billableWeightGrams.toFixed(1)} g</dd></div>
          {draft.businessRules.quote.promotionPrice!==null&&<div><dt>促销估算价 / ROI</dt><dd>${draft.businessRules.quote.promotionPrice.toFixed(2)} USD / {draft.businessRules.quote.promotionRoi===null?'未计算':`${(draft.businessRules.quote.promotionRoi*100).toFixed(1)}%`}</dd></div>}
        </dl>
      </div>}
      <details><summary>查看已填字段和原因 · {Object.keys(draft.businessRules.fields).length} 项</summary><ul>{Object.entries(draft.businessRules.fields).map(([field,entry])=><li key={field}><strong>{labels[field as CandidateField]??field}</strong><p className="small-copy">{entry.reason}</p><p>{textValue(entry.value)}</p></li>)}</ul></details>
    </div>}
    <div className="section-heading"><div><h4>手动英文字段建议</h4><p>可自行生成、选择写入，也可先运行独立复核。有复核结果时按最新结果处理。</p></div><span className={`status-badge ${stale||reviewBlocked?'warning':report?.verdict==='PASS'?'ready':''}`}>{stale?'建议已过期':report?.verdict==='PASS'?'复核通过':reviewBlocked?'需处理复核问题':output?reviewRequired?'旧建议需要复核':'尚未复核':'待生成建议'}</span></div>
    <div className="workflow-actions"><button type="button" className="button secondary" disabled={blocked} title={blockedReason} onClick={()=>void act('generate')}>生成英文字段建议</button><button type="button" className="button secondary" disabled={blocked||!output||stale||!output.candidates.length} title={blockedReason??(stale?'建议已过期':!output?.candidates.length?'没有可复核候选':undefined)} onClick={()=>void act('review')}>复核字段建议（可选）</button></div>
    {suggestions.length>0&&<label className="field"><span>建议记录</span><select aria-label="AI 字段建议记录" disabled={pending} value={suggestionId} onChange={e=>{setSuggestionId(e.target.value);setSelected([]);}}>{suggestions.map(r=><option key={r.id} value={r.id}>草稿修订 {r.listingContext?.draftRevision} · {new Date(r.createdAt).toLocaleString()} · {r.fieldGroupAssembly?[...new Set(r.fieldGroupAssembly.sources.map(s=>s.model))].join(' / '):r.model}</option>)}</select></label>}
    {output&&<div className="listing-ai-candidates">{output.candidates.map(candidate=><article className="listing-ai-candidate" key={candidate.field}>
      <label className="listing-ai-choice"><input type="checkbox" aria-label={`采纳${labels[candidate.field]}`} checked={selected.includes(candidate.field)} disabled={blocked||stale||reviewBlocked||reviewRequired} onChange={e=>setSelected(values=>e.target.checked?[...values,candidate.field]:values.filter(f=>f!==candidate.field))}/><strong>{labels[candidate.field]}</strong></label>
      <div className="listing-ai-diff"><div><span className="small-copy">草稿当前值</span><p>{textValue(draft.attributes[candidate.field])}</p></div><div><span className="small-copy">建议值</span>{candidate.items.map((item,index)=><p key={index}>{item.value}</p>)}</div></div>
      <details><summary>查看依据</summary>{candidate.items.map((item,i)=><div key={i}>{item.transformation==='infer'&&<p className="small-copy">模型推断：{item.inferenceReason}</p>}<p className="small-copy">{item.evidenceIds.map(id=>{const fact=suggestion?.listingContext?.evidence.find(e=>e.id===id);return fact?`${fact.name}：${fact.value}`:id;}).join('；')}</p></div>)}</details>
    </article>)}</div>}
    {!!output?.missing.length&&<div className="workflow-warning"><div><strong>本次未取得可用字段</strong><ul>{output.missing.map(m=><li key={m.field}>{labels[m.field]??m.field}：{m.reason}</li>)}</ul></div></div>}
    {!!report?.issues.length&&<div className="workflow-warning"><ul>{report.issues.map((issue,i)=><li key={i}>{labels[issue.field]??issue.field}：{issue.message}</li>)}</ul></div>}
    {output&&<div className="workflow-actions"><button type="button" className="button secondary" disabled={blocked||stale||reviewBlocked||reviewRequired||!selected.length} title={blockedReason??(stale?'建议已过期':reviewBlocked?'复核尚未通过':reviewRequired?'旧建议需要复核':!selected.length?'请先选择可用候选':undefined)} onClick={()=>void act('adopt')}>采纳所选字段并检查</button><span className="small-copy">{reviewBlocked?'最新复核未通过，请先处理问题。':reviewRequired?'这份旧建议仍需独立复核，或重新生成。':'请核对候选事实；采纳后仍需运行验证预览。'}</span></div>}
    {notice&&<p className="workflow-notice" role="status">{notice}</p>}
    {!!draft.fieldAdoptions?.length&&<details><summary>字段采纳记录 · {draft.fieldAdoptions.length} 次</summary>{draft.fieldAdoptions.map(a=><p className="small-copy" key={a.id}>修订 {a.fromRevision} → {a.toRevision} · {a.fields.map(f=>labels[f]).join('、')} · {a.reviewResultId?'含独立复核':'未运行独立复核'} · {new Date(a.at).toLocaleString()}</p>)}</details>}
  </section>;
}
