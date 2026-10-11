import type { Fact, ProductDetail, Variant } from '../../shared/contracts.ts';
import type { JsonObject, ListingIssue } from '../../shared/amazon-contracts.ts';
import type { SalesComponent } from '../../shared/sales-plan-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { isObject } from './context.ts';
import { sourceFieldName } from './demo.ts';

export const DECLARATION_SOURCE_CONFLICT = 'DECLARATION_SOURCE_CONFLICT';
export interface DeclarationScope { variants: readonly Variant[]; componentSpecifications: readonly string[] }
/** Caller has validated the recipe identity against the unprojected source product. */
export function selectedDeclarationScope(product: ProductDetail, variantId: string, components?: readonly Pick<SalesComponent,'variantId'|'specification'>[]): DeclarationScope {
  const ids=components?.map(component=>component.variantId)??[variantId];
  if(!ids.includes(variantId))throw new UserFacingError('销售组合与来源规格不一致');
  const variants=ids.map(id=>{
    const variant=product.variants.find(candidate=>candidate.id===id);
    if(!variant)throw new UserFacingError('所选安全声明的来源 SKU 不存在');
    return variant;
  });
  return {variants,componentSpecifications:components?.map(component=>component.specification)??[]};
}

const noBattery=/^(?:否|无|不需要|不含|false|no|none|not required)$/iu;
/** Retain the existing bounded vocabulary and separate electrical/chemical concerns. */
export function declarationRisks(product: ProductDetail, scope: DeclarationScope, facts: readonly Fact[]=product.facts) {
  const factText=facts.filter(fact=>['source_confirmed','human_confirmed','conflicting'].includes(fact.state) && !(fact.state!=='conflicting' && sourceFieldName(fact.name,'haul')==='batteries_required' && noBattery.test(fact.value.trim()))).map(fact=>`${fact.name}:${fact.value}`).join('\n');
  const text=[product.title,product.description,factText,...scope.variants.flatMap(variant=>[variant.sourceSpec,variant.originalSpec,variant.normalizedSpec]),...scope.componentSpecifications].join('\n');
  const physicalRisk=/电动|充电|电池|清洗剂|清洁剂|消毒|农药|驱虫|气雾|喷雾|复合木|刨花板|密度板|\bbattery\b|\baerosol\b|\bpesticide\b/iu.test(text);
  const batteryRisk=/电动|充电|电池|\bbatter(?:y|ies)\b|\brechargeable\b|\belectric\b/iu.test(text);
  const batteryFact=facts.some(fact=>/电池|batter/i.test(fact.name)&&!noBattery.test(fact.value.trim()));
  const complianceConflict=facts.some(fact=>fact.state==='conflicting'&&/合规|危险|电池|液体|证书|certif|battery|hazard/i.test(fact.name));
  const specialDeclaration=facts.some(fact=>['source_confirmed','human_confirmed','conflicting'].includes(fact.state)
    &&['supplier_declared_dg_hz_regulation','required_product_compliance_certificate'].includes(sourceFieldName(fact.name,'haul'))&&!/^(?:not[ _]applicable|不适用)$/iu.test(fact.value.trim()));
  return {battery:batteryRisk||batteryFact,compliance:physicalRisk||batteryFact||complianceConflict||specialDeclaration};
}

/** Current authorization only: keep supplied values and historical evidence unchanged. */
export function declarationSafetyIssues(product: ProductDetail, scope: DeclarationScope, attributes: JsonObject): ListingIssue[] {
  // A confirmed "是否需要电池: 否" does not contradict itself merely because its
  // field name contains 电池. It cannot cancel risk in any other source or SKU text.
  const facts=product.facts.filter(fact=>!(fact.state!=='conflicting'&&sourceFieldName(fact.name,'haul')==='batteries_required'&&noBattery.test(fact.value.trim())));
  const risk=declarationRisks(product,scope,facts),issues:ListingIssue[]=[];
  for(const [field,blocked] of [['batteries_required',risk.battery],['supplier_declared_dg_hz_regulation',risk.compliance],['required_product_compliance_certificate',risk.compliance]] as const){
    const values=attributes[field];
    if(!blocked||!Array.isArray(values)||!values.some(value=>isObject(value)&&(field==='batteries_required'?value.value===false:typeof value.value==='string'&&/^not[ _]applicable$/iu.test(value.value.trim()))))continue;
    issues.push({code:DECLARATION_SOURCE_CONFLICT,severity:'ERROR',category:'compliance',source:'local',autoFixable:false,attributeNames:[field],
      message:`${field} 的无电池或不适用声明与当前商品／所选销售规格中的风险信息不一致，须核对来源后确认；已有值和历史记录保留，未推断相反声明`});
  }
  return issues;
}
