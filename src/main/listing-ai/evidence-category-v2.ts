/** Finite, field-scoped parsing for listing-evidence/v2. v0/v1 remain immutable. */
import { categoryAttributeValues as previousValues, sourceFieldName, categoryAttributeSourceOptions } from './evidence-category-v1.ts';
import { CATEGORY_ATTRIBUTE_FIELDS } from '../../shared/listing-ai-contracts.ts';
export { sourceFieldName, categoryAttributeSourceOptions };

export const SCOPED_CATEGORY_FIELDS=['age_range_description','item_firmness_description','power_source_type'] as const;
export interface CategorySourceValue { present:boolean; values:string[]; excluded:string[]; unresolved:string[]; unparsed:boolean }
// Bare commas/slashes continue a list. A finite affirmative introducer can
// restart after a comma; arbitrary conjunctions never receive that permission.
export const categoryClauses=(value:string):string[]=>value.split(/[;；。.!?！？\n\r|·]+|[,，]\s*(?=适用(?:于)?|适合|(?:suitable|intended|recommended)\s+for\b)/iu).map(value=>value.trim()).filter(Boolean);
const negative=/不|无|非|禁止|禁用|\b(?:not|no|without|never|false|unsuitable|non)\b/giu;
const negativePrefix=/(?:不(?:适合|适用(?:于)?|适宜|是|属于|支持|供)?|非|无|禁止(?:用于|供)?|\b(?:not(?:\s+(?:suitable|intended|recommended))?(?:\s+for)?|no|without|never|unsuitable(?:\s+for)?|non)[ -]*)\s*$/iu;
const negativeSuffix=/^\s*[:：-]?\s*(?:不适用|不适合|不宜|禁用|禁止|not\s+(?:suitable|supported|allowed))\s*$/iu;
const tokens:Record<string,Record<string,RegExp>>={
  age_range_description:{Baby:/婴儿|婴幼儿|\b(?:baby|babies|infants?)\b/iu,Child:/儿童|小孩|幼儿|\b(?:child|children|kids?|toddler)\b/iu,Adult:/成人|成年|\badults?\b/iu},
  item_firmness_description:{'Extra Soft':/超软|极软|\b(?:extra|ultra)[ -]soft\b/iu,Soft:/软毛|柔软|^软$|\bsoft\b/iu,Medium:/中毛|中等硬度|^中$|\bmedium\b/iu,Hard:/硬毛|硬质|^硬$|\b(?:hard|firm)\b/iu},
  power_source_type:{Manual:/手动|手摇|\b(?:manual|hand[ -]powered)\b/iu,'Battery Powered':/电池驱动|电池供电|\bbattery[ -]powered\b/iu,'Corded Electric':/插电|有线电动|\bcorded[ -]electric\b/iu,Electric:/电动|\belectric\b/iu},
  operation_mode:{Manual:/手动|手摇|粘毛滚|\bmanual\b/iu,Automatic:/自动|\bautomatic\b/iu,Adhesive:/粘毛|黏胶|粘胶|adhesive/iu,Brushing:/刷|brushing/iu},
};
const mentions:Record<string,RegExp>={
  age_range_description:/适用年龄|年龄范围|适用人群|age[ _-]?range|(?:[\d一二三四五六七八九十两]+)\s*(?:岁|years?\s*(?:old|and\s+(?:up|over)))/iu,
  item_firmness_description:/刷毛(?:硬度|软硬度|类型)?|软硬度|硬度|bristle[ -]?(?:type|firmness)|firmness/iu,
  power_source_type:/供电方式|电源类型|动力来源|power[ _-]?source|无电池|without\s+batter(?:y|ies)|no\s+batter(?:y|ies)/iu,
  operation_mode:/操作方式|工作方式|运行方式|驱动方式|operation[ _-]?mode|非电动|not\s+electric/iu,
};
const unique=(values:string[])=>[...new Set(values)];
// Negative scope needs every separately mentioned term, even when affirmative
// normalization keeps only a subtype. Mask subtype occurrences only while
// checking their broader token, so "extra soft" alone never also names "Soft".
const categoryTerms=(field:string,clause:string)=>Object.entries(tokens[field]).filter(([name,pattern])=>{
  const subtype=field==='power_source_type'&&name==='Electric'?'Corded Electric':field==='item_firmness_description'&&name==='Soft'?'Extra Soft':undefined;
  const text=subtype?clause.replace(new RegExp(tokens[field][subtype].source,'giu'),word=>' '.repeat(word.length)):clause;
  return pattern.test(text);
}).map(([name])=>name);
const excludedOptions=(field:string,values:string[])=>unique(values.flatMap(value=>
  field==='power_source_type'&&value==='Electric'?[value,'Corded Electric']:
  field==='item_firmness_description'&&value==='Soft'?[value,'Extra Soft']:[value]));

/** Presence and exclusion are retained separately; exclusion never supplies an opposite value. */
export function parseCategorySource(field:string,value:string):CategorySourceValue {
  if(field==='target_audience'){
    const age=parseCategorySource('age_range_description',value);if(age.present)return age;
    const names:Record<string,string>={'通用':'General','all':'General','general':'General','general use':'General','男女通用':'Unisex','unisex':'Unisex','men and women':'Unisex','男士':'Men','女士':'Women','老年人':'Seniors','elderly':'Seniors'};
    // Outside the finite age role, keep the previous audience fallback exactly;
    // e.g. the explicit audience Non-smokers is not a negated age assertion.
    const key=value.trim().toLowerCase(),neg=/不|无|非|禁止|\b(?:not|no|without|never|false)\b/iu.test(value),values=neg?[]:Object.hasOwn(names,key)?[names[key]]:/^[A-Za-z -]+$/.test(value)?[value]:[];
    return {present:!!value.trim(),values,excluded:[],unresolved:[],unparsed:!values.length};
  }
  if(!Object.hasOwn(tokens,field)){
    const values=previousValues(field,value);return {present:!!values.length,values,excluded:[],unresolved:[],unparsed:!values.length};
  }
  const result:CategorySourceValue={present:false,values:[],excluded:[],unresolved:[],unparsed:false};
  for(const clause of categoryClauses(value)){
    // An explicit absence of batteries excludes battery power, not all electricity or hand power.
    if(field==='power_source_type'&&/^(?:无电池|无需电池|不需要电池|without\s+batter(?:y|ies)|no\s+batter(?:y|ies))$/iu.test(clause)){
      result.present=true;result.excluded.push('Battery Powered');continue;
    }
    const values=field==='operation_mode'?Object.entries(tokens[field]).filter(([,pattern])=>pattern.test(clause)).map(([name])=>name):previousValues(field,clause);
    if(!values.length){
      if(field==='operation_mode'){
        const power=parseCategorySource('power_source_type',clause);
        if(power.excluded.length&&!power.unparsed){result.present=true;result.excluded.push(...power.excluded);continue;}
      }
      if(mentions[field].test(clause)){result.present=true;result.unparsed=true;}continue;
    }
    result.present=true;
    // Fixed nonnegative modifiers are not category operators. Keep offsets so
    // the remaining operator must still bind to the known value in this clause.
    const polarity=clause.replace(/非常|不锈钢|无线|\bnon[ -]slip\b/giu,word=>' '.repeat(word.length));
    const negatives=polarity.match(negative)??[];
    if(!negatives.length){result.values.push(...values);continue;}
    const terms=categoryTerms(field,clause);
    // One explicit operator and one known value per clause. Double negation and
    // conjunctions with unclear scope remain unparsed instead of guessing polarity.
    if(negatives.length!==1||terms.length!==1){result.unparsed=true;result.unresolved.push(...terms);continue;}
    const match=tokens[field][terms[0]].exec(clause)!;
    if(negativePrefix.test(polarity.slice(0,match.index))||negativeSuffix.test(polarity.slice(match.index+match[0].length)))result.excluded.push(terms[0]);
    else {result.unparsed=true;result.unresolved.push(...terms);}
  }
  if(field==='operation_mode'&&!result.present&&/^[A-Za-z -]+$/.test(value)&&!value.match(negative))return {present:true,values:[value],excluded:[],unresolved:[],unparsed:false};
  result.values=unique(result.values);result.excluded=excludedOptions(field,result.excluded);result.unresolved=excludedOptions(field,result.unresolved);
  return result;
}

export function categoryAttributeValues(field:string,value:string):string[]{
  const parsed=parseCategorySource(field,value);
  return parsed.unparsed?[]:parsed.values.filter(value=>!parsed.excluded.includes(value));
}

/** Candidate constraints retain unresolved mentions without granting affirmative
 * support. Source exclusion expansion must not invent a narrower candidate claim. */
export function categoryClaimTerms(field:string,value:string):string[]{
  return unique(categoryClauses(value).flatMap(clause=>{
    const parsed=parseCategorySource(field,clause),mentioned=Object.hasOwn(tokens,field)?categoryTerms(field,clause):[];
    return [...parsed.values,...parsed.unresolved.filter(term=>mentioned.includes(term))];
  }));
}

export function categoryAttributeField(name:string,value:string):string|undefined {
  const field=sourceFieldName(name,'haul');if((CATEGORY_ATTRIBUTE_FIELDS as readonly string[]).includes(field))return field;
  if(/^(?:产品类别|产品类型|商品类型|工作方式|操作方式|operation_mode|category|product[ _-]?type)$/iu.test(name.trim())&&parseCategorySource('power_source_type',value).present)return 'power_source_type';
  if(/^(?:功能|刷毛类型|刷毛|bristles?)$/iu.test(name.trim())&&parseCategorySource('item_firmness_description',value).present)return 'item_firmness_description';
  return undefined;
}
