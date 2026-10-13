import type { Fact, Variant } from '../shared/contracts';
export function FactScopeEditor({fact,variants,index,onChange}:{fact:Fact;variants:Variant[];index:number;onChange:(patch:Partial<Fact>)=>void}){
  return <div className="fact-origin"><label className="field"><span>人工确认适用范围</span><select aria-label={`事实范围 ${index+1}`} value={fact.scope??'legacy'} onChange={event=>{
    const scope=event.target.value as NonNullable<Fact['scope']>;
    onChange({scope,variantId:scope==='variant'?variants[0]?.id:undefined});
  }}>{!fact.scope&&<option value="legacy">历史未标范围（兼容原解释）</option>}<option value="unknown">未知（不作为 SKU 事实依据）</option><option value="common">共用（适用全部规格）</option><option value="variant" disabled={!variants.length}>逐规格（仅指定 SKU）</option></select></label>
  {fact.scope==='variant'&&<label className="field"><span>适用 SKU</span><select aria-label={`事实适用 SKU ${index+1}`} value={fact.variantId??''} onChange={e=>onChange({variantId:e.target.value})}>{variants.map(v=><option key={v.id} value={v.id}>{v.sku} · {v.originalSpec||'未填写规格'}</option>)}</select></label>}
  <small>范围选择随“保存修改”确认；不改变原始来源及事实确认状态。未知资料不会自动用于全部 SKU。</small></div>;
}
