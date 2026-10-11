import { useEffect,useRef,useState } from 'react';
import type { ProductDetail } from '../shared/contracts';
import type { SourceConsistencyView } from '../shared/source-image-consistency-contracts';

const statuses={PENDING:'待核对',MATCH:'观察一致',MANUAL:'已人工确认关联',NEEDS_INPUT:'需要补充或更正',SYSTEM_REPAIR:'需要修复记录',UNKNOWN:'请求结果未知，不自动重发'};
const reasonText:Record<string,string>={SOURCE_CONSISTENCY_PENDING:'尚无当前图片与规格的观察或人工决定',RAW_NORMALIZED_CONFLICT:'原始规格与当前规格存在冲突',RANDOM_OR_AMBIGUOUS_FULFILLMENT:'规格含随机或混款供货，示例图不能保证实际供货',VISUAL_UNCERTAINTY:'清晰度、遮挡、光线或多款展示不足以判断',CLAIM_NOT_VISIBLE:'部分规格特征不可见',NO_COMPARABLE_CLAIM:'没有可直接比较的可见特征',UNSUPPORTED_STYLE:'款式名称需要人工核对',UNSUPPORTED_COLOR:'颜色名称超出有限比较范围',NEGATED_CLAIM:'原文含否定描述，需要核对含义',SOURCE_CONSISTENCY_SENT_UNKNOWN:'已有发送结果未知，请核对调用记录，更换模型不会自动重发',SOURCE_CONSISTENCY_INVALID_OUTPUT:'观察格式不符合要求，不自动重复付费',SOURCE_CONSISTENCY_RECOVERY_REQUIRED:'已保存观察，可本地恢复评估，无需重新请求',SUPPORTED_VISIBLE_CLAIMS_MATCH:'受支持的可见规格特征一致',HUMAN_VISUAL_ASSOCIATION_ONLY:'已确认当前视觉关联',HUMAN_CORRECTION_REQUIRED:'人工要求更正图片或规格'};
export function SourceConsistencyPanel({product,busy}:{product:ProductDetail;busy:boolean}){
  const[variantId,setVariantId]=useState(product.variants[0]?.id??''),[view,setView]=useState<SourceConsistencyView|null>(null),[reason,setReason]=useState(''),[working,setWorking]=useState(false),[error,setError]=useState('');
  const selected=product.variants.find(v=>v.id===variantId)??product.variants[0];
  const input={productId:product.id,productRevision:product.revision,variantId:selected?.id??''};
  const scope=JSON.stringify(input),scopeRef=useRef(scope),operation=useRef(0);scopeRef.current=scope;
  useEffect(()=>{let current=true;operation.current++;setView(null);setReason('');setError('');setWorking(false);if(selected)window.red.getSourceConsistency(input).then(value=>{if(current)setView(value);}).catch(e=>{if(current)setError(e instanceof Error?e.message:'读取失败');});return()=>{current=false;operation.current++;};},[product.id,product.revision,selected?.id]);
  const act=async(decision?:'CONFIRMED'|'CORRECTION_NEEDED')=>{const token=++operation.current,isCurrent=()=>operation.current===token&&scopeRef.current===scope;setWorking(true);setError('');try{const result=decision&&view?await window.red.decideSourceConsistency({...input,fingerprint:view.fingerprint,decision,reason:reason.trim()}):await window.red.prepareSourceConsistency(input);if(isCurrent())setView(result);}catch(e){if(isCurrent())setError(e instanceof Error?e.message:'处理失败');}finally{if(isCurrent())setWorking(false);}};
  const modern=view?.context.version==='source-image-consistency/v2';
  const disabled=busy||working,unresolvable=view?.status==='UNKNOWN'||!modern&&view?.context.issues.some(issue=>['RAW_NORMALIZED_CONFLICT','RANDOM_OR_AMBIGUOUS_FULFILLMENT','NEGATED_CLAIM'].includes(issue));
  return <section aria-label="原图与规格一致性">
    <div className="section-heading"><div><h3>来源规格与图片观察</h3><p>沿用来源 SKU 图片关联，合并来源原文与独立识别。型号无法解析不阻止商品；明确矛盾只提示对应属性。</p></div></div>
    <label className="field-label">核对 SKU<select value={selected?.id??''} disabled={disabled} onChange={e=>setVariantId(e.target.value)}>{product.variants.map(v=><option key={v.id} value={v.id}>{v.sku} · {v.originalSpec||'未填规格'}</option>)}</select></label>
    {view&&<><p role="status"><strong>{modern&&view.status==='MATCH'?'已完成识别与观察合并':statuses[view.status]}</strong></p>
      {view.context.referenceAssets.map(ref=>{const asset=product.assets.find(a=>a.id===ref.assetId);return asset?<figure key={ref.assetId}><img src={asset.previewUrl} alt={`${selected?.sku} 当前原图`} width={144} height={144}/><figcaption>{ref.source==='receipt-image'?'供应商映射原图':'已关联本地原图（非供应商锚定图）'}</figcaption></figure>:null;})}
      <dl>{view.context.fields.map(field=><div key={field.id}><dt>{field.id.startsWith('receipt.')?`回执原文 · ${field.name}`:field.id==='variant.sourceSpec'?'保留来源规格':field.id==='variant.originalSpec'?'当前原始规格':'当前规范规格'}</dt><dd>{field.value||'未填写'}</dd></div>)}</dl>
      {view.observations?.assets.map(asset=><p key={asset.assetId}>观察：{asset.colors.join(' / ')||'颜色未知'}；{asset.appearance.join(' / ')||'外观未知'}；{asset.quality==='clear'?'清晰':'细节不足'}；{asset.visibility==='complete'?'无遮挡':'存在遮挡'}；{asset.lighting==='neutral'?'光线正常':'光线不确定'}；{asset.presentation==='single-product'?'单一产品':'多款或无法区分'}</p>)}
      {view.observations?.assets.flatMap(asset=>(asset.observations??[]).map((observation,index)=><p key={`${asset.assetId}:${index}`}>{observation.name}：{observation.values.join(' / ')||'未知'}{observation.visibility==='unknown'?'（不确定）':''}</p>))}
      <ul>{view.reasons.map(code=><li key={code}>{code==='SOURCE_BINDING_REUSED'?'已沿用来源图片关联，图片观察保留独立来源':modern&&code==='UNSUPPORTED_STYLE'?'来源型号或款式保留原文，未解析部分不阻止继续':modern&&code==='UNSUPPORTED_COLOR'?'来源颜色保留原文，可结合图片观察填写':code.startsWith('VISIBLE_CONTRADICTION:')?`属性矛盾：${view.context.claims.find(c=>c.id===code.slice('VISIBLE_CONTRADICTION:'.length))?.raw??'颜色或外观'}；仅需核对此属性`:reasonText[code]??code}</li>)}</ul>
      {view.humanDecision&&<p>人工说明：{view.humanDecision.reason}</p>}
      <button className="button secondary" type="button" disabled={disabled||!['PENDING','SYSTEM_REPAIR'].includes(view.status)} onClick={()=>void act()}>{working?'处理中…':view.status==='SYSTEM_REPAIR'?'从本地已保存响应恢复（不重新付费）':'观察当前原图（AI；同一范围最多一次请求）'}</button>
      <label className="field-label">核对说明<textarea value={reason} maxLength={1000} disabled={disabled} onChange={e=>setReason(e.target.value)} placeholder="说明核对过的可见特征，或需要更正什么"/></label>
      <div className="button-row"><button type="button" className="button secondary" disabled={disabled||!reason.trim()||unresolvable} onClick={()=>void act('CONFIRMED')}>确认当前图片关联</button><button type="button" className="button secondary" disabled={disabled||!reason.trim()} onClick={()=>void act('CORRECTION_NEEDED')}>需要更正</button></div>
      <p className="small-copy muted">仅确认当前视觉关联，不验证尺寸、材质或随机供货，不改写资料。图片、规格或关联变化后需重新核对；未知付费请求不会因此解除。</p>
    </>}{error&&<p role="alert">{error}</p>}
  </section>;
}
