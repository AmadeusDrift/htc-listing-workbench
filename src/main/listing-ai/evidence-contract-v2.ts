/** Immutable decisions for listing-evidence/v2; future policy changes require a new version. */
import { CATEGORY_ATTRIBUTE_FIELDS, LISTING_CANDIDATE_FIELDS } from '../../shared/listing-ai-contracts.ts';
import type { CandidateField, ListingAiContext, ListingEvidence } from '../../shared/listing-ai-contracts.ts';
import { categoryAttributeField, categoryAttributeValues, categoryAttributeSourceOptions, sourceFieldName, parseCategorySource, categoryClauses, categoryClaimTerms } from './evidence-category-v2.ts';

export type EvidenceDecision =
  | {status:'supported';ruleId:string;evidenceIds:string[]}
  | {status:'conflict';reason:'source_conflict'|'value_mismatch';evidenceIds:string[]}
  | {status:'unparsed';reason:'source_absent'|'source_unparsed'|'candidate_unparsed';evidenceIds:string[]};
export type EvidenceScope=Pick<ListingAiContext,'evidence'> & Partial<Pick<ListingAiContext,'evidenceBlockers'>>;
const normalized=(text:string)=>text.toLowerCase().replace(/[\s_-]/g,'');
const explicitOperationField=(name:string)=>/^(?:工作方式|操作方式|运行方式|驱动方式|operationmode)$/.test(normalized(name));
/** Shared finite translations already used by direct shape validation. */
export const SHAPE_TRANSLATIONS:Record<string,string[]>={'方形':['square'],'正方形':['square'],'圆形':['round'],'长方形':['rectangular','rectangle']};
export function evidenceRole(name:string,value:string):CandidateField|undefined{
  const category=categoryAttributeField(name,value);if(category)return category as CandidateField;
  const field=sourceFieldName(name,'haul');
  if(field==='target_audience')return 'age_range_description';
  if((LISTING_CANDIDATE_FIELDS as readonly string[]).includes(field))return field as CandidateField;
  const n=normalized(name);
  if(/^(?:适用对象|目标人群|使用人群|targetaudience|intendedusers)$/.test(n))return 'age_range_description';
  if(explicitOperationField(name))return 'operation_mode';
  if(/^(?:材质|材料|面料|面料成分|材料成分|material|fabrictype|fabriccomposition)$/.test(n))return 'material';
  if(/^(?:颜色|色系|color|colour)$/.test(n))return 'color';
  if(/^(?:形状|外形|造型|外观造型|shape|itemshape)$/.test(n))return 'item_shape';
  if(/^(?:护理说明|清洗说明|清洁方式|洗涤说明|careinstructions|care)$/.test(n))return 'care_instructions';
  return undefined;
}
export function categorySources(name:string,evidence:ListingEvidence[]):ListingEvidence[]{
  const role=name==='target_audience'?'age_range_description':name;
  const direct=evidence.filter(e=>evidenceRole(e.name,e.value)===role||(name==='operation_mode'&&evidenceRole(e.name,e.value)==='power_source_type'));
  const selected=direct.filter(e=>e.source==='selected_sku');if(selected.length)return selected;
  const specRole=name==='operation_mode'?'power_source_type':role;
  const specs=['age_range_description','item_firmness_description','power_source_type'].includes(specRole)?evidence.filter(e=>e.source==='selected_sku'&&e.name==='Selected SKU specification'&&parseCategorySource(specRole,e.value).present):[];
  return specs.length?specs:direct;
}
export function decideEvidence(field:CandidateField,value:string,context:EvidenceScope):EvidenceDecision{
  const role=field==='target_audience'?'age_range_description':field==='operation_mode'?'power_source_type':field;
  const blocker=context.evidenceBlockers?.find(b=>b.field===role||b.field===field);
  if(blocker)return {status:'conflict',reason:'source_conflict',evidenceIds:blocker.facts.map(f=>f.id)};
  const sources=categorySources(field,context.evidence),evidenceIds=sources.map(e=>e.id);
  if(!sources.length)return {status:'unparsed',reason:'source_absent',evidenceIds};
  const normalize=(text:string)=>field==='ingredients'?text.toLowerCase().split(/\s*\+\s*/).sort().join('+'):text.toLowerCase().trim();
  const parsed=sources.map(e=>{
    if(field==='operation_mode'&&!explicitOperationField(e.name)&&evidenceRole(e.name,e.value)==='power_source_type'){
      const power=parseCategorySource('power_source_type',e.value);
      const exact=categoryClauses(e.value).every(clause=>!parseCategorySource('power_source_type',clause).values.length||/^(?:手动|手摇|manual|hand[ -]powered)$/i.test(clause));
      return {...power,values:exact&&power.values.every(value=>value==='Manual')?power.values:[],unparsed:power.unparsed||!exact};
    }
    return parseCategorySource(field,e.value);
  });
  if(parsed.some(entry=>entry.unparsed))return {status:'unparsed',reason:'source_unparsed',evidenceIds};
  const expected=[...new Set(parsed.flatMap(entry=>entry.values).map(normalize))],excluded=parsed.flatMap(entry=>entry.excluded).map(normalize);
  if(expected.length>1||expected.some(value=>excluded.includes(value)))return {status:'conflict',reason:'source_conflict',evidenceIds};
  const candidate=parseCategorySource(field,value),actual=candidate.values;
  if(candidate.unparsed||candidate.excluded.length||!actual.length)return {status:'unparsed',reason:'candidate_unparsed',evidenceIds};
  if(actual.some(value=>excluded.includes(normalize(value))))return {status:'conflict',reason:'value_mismatch',evidenceIds};
  if(!expected.length)return {status:'unparsed',reason:'source_unparsed',evidenceIds};
  const allowed=expected.flatMap(value=>categoryAttributeSourceOptions(field,value)).map(normalize);
  // Preserve this source-specific legacy translation without equating General and Unisex.
  if(field==='target_audience'&&value.trim().toLowerCase()==='unisex'&&sources.every(e=>e.value.trim()==='通用'&&/^(?:适用人群|适用对象|目标人群|使用人群|targetaudience|intendedusers)$/.test(normalized(e.name))))allowed.push('unisex');
  if(actual.some(value=>!allowed.includes(normalize(value))))return {status:'conflict',reason:'value_mismatch',evidenceIds};
  return {status:'supported',ruleId:field==='target_audience'?'explicit-age-to-audience':field==='operation_mode'?'explicit-operation-or-manual-power':'explicit-category-value',evidenceIds};
}
export function blockedClaim(field:CandidateField,value:string,context:EvidenceScope):boolean{
  return !!context.evidenceBlockers?.some(blocker=>{
    if(blocker.field===field||field==='target_audience'&&blocker.field==='age_range_description'||field==='operation_mode'&&blocker.field==='power_source_type'||field==='fabric_type'&&blocker.field==='material')return true;
    if(!['item_name','bullet_point','product_description','generic_keyword'].includes(field))return false;
    if(['age_range_description','power_source_type'].includes(blocker.field))return categoryClaimTerms(blocker.field,value).length>0;
    if(blocker.field==='item_firmness_description')return /\b(?:soft|medium|hard|firm)(?:[- ](?:bristles?|bristled|toothbrush))\b/iu.test(value);
    if(blocker.field==='material')return /\b(?:silicone|cotton|polyester|plastic|stainless steel|metal|wood|glass|ceramic|resin|nylon|wool|linen)\b/i.test(value);
    if(blocker.field==='ingredients')return blocker.facts.flatMap(f=>categoryAttributeValues('ingredients',f.value)).flatMap(v=>v.split(/\s*\+\s*/)).some(v=>value.toLowerCase().includes(v.toLowerCase()));
    if(blocker.field==='item_shape')return blocker.facts.some(f=>{
      const source=f.value.trim(),english=source.toLowerCase();
      const shapes=Object.hasOwn(SHAPE_TRANSLATIONS,source)?SHAPE_TRANSLATIONS[source]:Object.values(SHAPE_TRANSLATIONS).flat().includes(english)?[english]:undefined;
      return shapes?shapes.some(shape=>new RegExp(`\\b${shape}\\b`,'i').test(value)):/^[A-Za-z -]+$/.test(f.value)&&value.toLowerCase().includes(f.value.toLowerCase());
    });
    return blocker.facts.some(f=>/^[A-Za-z -]+$/.test(f.value)&&value.toLowerCase().includes(f.value.toLowerCase()));
  });
}
/** Existing copy has no invented inference metadata. Missing-source defaults belong to their own repair. */
export function currentCopyEvidenceIssues(copy:{field:CandidateField;values:string[]}[],context:EvidenceScope):{field:CandidateField;reason:string}[]{
  return copy.flatMap(item=>item.values.flatMap(value=>{
    if(blockedClaim(item.field,value,context))return [{field:item.field,reason:'来源事实存在冲突，当前声明不能继续使用'}];
    if(!(CATEGORY_ATTRIBUTE_FIELDS as readonly string[]).includes(item.field)&&!['target_audience','operation_mode'].includes(item.field))return [];
    const decision=decideEvidence(item.field,value,context);
    return decision.status==='supported'||decision.status==='unparsed'&&decision.reason==='source_absent'?[]:[{field:item.field,reason:'当前字段的明确来源无法支持其值'}];
  }));
}
