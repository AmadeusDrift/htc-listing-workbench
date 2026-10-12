import { isDeepStrictEqual } from 'node:util';
import type { AmazonSchema, AmazonTarget, JsonObject, ListingIssue } from '../../shared/amazon-contracts.ts';
import type { ProductDetail } from '../../shared/contracts.ts';
import { isObject } from './context.ts';
import { effectiveSourceMeasurements, measurementFactName, sourceFactValue, sourceFieldName } from './demo.ts';
import { convertToUnit, DIMENSION_FIELDS } from './field-mapping.ts';
import type { ConfirmedMeasurements, MeasurementSet } from './field-mapping.ts';
import { fieldSchema, resolveSchemaNode } from './field-catalog.ts';

export const FACT_AUTHORITY_REQUIRED = 'FACT_AUTHORITY_REQUIRED';
export const FACT_SOURCE_CONFLICT = 'FACT_SOURCE_CONFLICT';
const declarationFields = ['brand','manufacturer','country_of_origin','import_designation','gpsr_safety_attestation',
  'batteries_required','supplier_declared_dg_hz_regulation','required_product_compliance_certificate'];
const physicalFields = [...DIMENSION_FIELDS,'item_weight','item_package_weight'];
export const FACT_PROTECTED_FIELDS = new Set([...declarationFields,...physicalFields]);
export interface FieldAuthority { supported: boolean; conflicting: boolean; sourceFactIds: string[]; unsupported: string[] }
export interface CurrentFactAuthority { fields: Map<string,FieldAuthority>; issues: ListingIssue[] }

/** Resolve current affirmative evidence, before any editable-value overlay or estimator fallback.
 * The caller supplies a validated sales projection and only receipts matching its package.
 * Missing siblings belong to schema validation; every present component needs its own support.
 */
export function currentFactAuthority(product: ProductDetail, schema: AmazonSchema, target: Pick<AmazonTarget,'marketplaceId'>,
  attributes: JsonObject, receipt: ConfirmedMeasurements = {}, ruleValues: JsonObject = {}): CurrentFactAuthority {
  const fields = new Map<string,FieldAuthority>(), issues: ListingIssue[] = [];
  const resolve = (raw:unknown):JsonObject => { try { return raw===undefined?{}:resolveSchemaNode(schema.schema,raw as JsonObject); } catch { return {}; } };
  const normalized = (field:string,value:string) => { try { return sourceFactValue(schema,field,value); } catch { return undefined; } };
  const applicable = product.facts.filter(fact => ['source_confirmed','human_confirmed','conflicting'].includes(fact.state));
  const scalar = (field:string) => {
    const facts = applicable.filter(fact => sourceFieldName(fact.name,'haul') === field);
    const values = new Set(facts.map(fact => JSON.stringify(normalized(field,fact.value.trim()))));
    return {facts,conflicting:facts.some(fact=>fact.state==='conflicting')||values.size>1,
      value:facts.length&&values.size===1&&facts.every(fact=>fact.value.trim())?normalized(field,facts[0].value.trim()):undefined};
  };
  const record = (field:string, result:FieldAuthority) => {
    // ruleValues must be freshly derived by the caller from current store/SKU configuration.
    // Never accept a saved report alone as authority, and never mask explicit conflicts.
    if (!result.conflicting && Object.hasOwn(ruleValues, field) && isDeepStrictEqual(ruleValues[field], attributes[field])) result.supported = true;
    result.sourceFactIds = [...new Set(result.sourceFactIds)]; fields.set(field,result);
    if(result.supported)return;
    issues.push({code:result.conflicting?FACT_SOURCE_CONFLICT:FACT_AUTHORITY_REQUIRED,severity:'ERROR',category:/gpsr|batter|regulation|certificate/.test(field)?'compliance':'fact',
      source:'local',autoFixable:false,attributeNames:[field],message:result.conflicting
        ? `${field} 的当前来源事实存在冲突，须核对后再提交；已有属性与历史记录保留`
        : `${field}${result.unsupported.length?`（${result.unsupported.join('、')}）`:''} 缺少匹配当前销售规格的已确认事实或有效 SKU 回执；未匹配当前业务规则，直接保存的数值不构成事实确认`});
  };
  for(const field of declarationFields){
    if(!Object.hasOwn(attributes,field))continue;
    let {facts,conflicting,value}=scalar(field);
    if(field==='import_designation'&&value===undefined&&!conflicting&&target.marketplaceId==='ATVPDKIKX0DER'){
      const origin=scalar('country_of_origin');
      conflicting=origin.conflicting;
      if(!conflicting&&origin.value==='CN'){value='Imported';facts=origin.facts;}
    }
    const raw=attributes[field],entries=Array.isArray(raw)?raw:[raw];
    const supported=!conflicting&&value!==undefined&&entries.length>0&&entries.every(entry=>JSON.stringify(isObject(entry)?entry.value:entry)===JSON.stringify(value));
    record(field,{supported,conflicting,sourceFactIds:supported?facts.map(fact=>fact.id):[],unsupported:[]});
  }
  const {measurements,blocked}=effectiveSourceMeasurements(product,receipt);
  for(const field of physicalFields){
    if(!Object.hasOwn(attributes,field))continue;
    const scope=field.startsWith('item_package_')?'package':'item',set=measurements[scope]??{};
    const raw=attributes[field],entries=Array.isArray(raw)?raw:[raw];
    let node:JsonObject={};try{node=fieldSchema(schema,field);}catch{ /* Schema owns unsupported properties; authority remains absent. */ }
    const item=resolve(node.type==='array'?node.items:node);
    const result:FieldAuthority={supported:true,conflicting:false,sourceFactIds:[],unsupported:[]};
    let components=0;
    const check=(axis:keyof MeasurementSet,current:unknown,rawSchema:unknown)=>{
      components++;
      const sourceAxis=axis==='depth'&&set.depth===undefined&&!blocked[`${scope}.depth`]?'length':axis;
      const role=`${scope}.${sourceAxis}`,input=set[sourceAxis];
      const facts=product.variants.length===1?applicable.filter(fact=>measurementFactName(fact.name)===role):[];
      const conflicting=facts.some(fact=>fact.state==='conflicting')||new Set(facts.map(fact=>fact.value.trim())).size>1;
      result.conflicting ||= conflicting;
      const shape=resolve(rawSchema),properties=isObject(shape.properties)?shape.properties:{};
      const units=resolve(properties.unit),valueKey=properties.value?'value':properties.decimal_value?'decimal_value':null;
      const unit=isObject(current)?current.unit:undefined;
      const allowed=Object.hasOwn(properties,'unit')&&typeof unit==='string'&&(typeof units.const==='string'?unit===units.const:Array.isArray(units.enum)?units.enum.includes(unit):true);
      const converted=input&&typeof unit==='string'?convertToUnit(input.value,input.unit,axis==='weight'?'weight':'length',unit):null;
      const supported=!conflicting&&!blocked[role]&&allowed&&valueKey!==null&&isObject(current)&&typeof current[valueKey]==='number'
        &&converted?.status==='mapped'&&current[valueKey]===converted.value;
      if(supported)result.sourceFactIds.push(...facts.map(fact=>fact.id));
      else{result.supported=false;result.unsupported.push(axis);}
    };
    for(const entry of entries){
      if(!isObject(entry)){result.supported=false;continue;}
      let nested=false;
      for(const axis of ['length','width','height','depth','thickness'] as const)if(Object.hasOwn(entry,axis)){
        nested=true;check(axis,entry[axis],isObject(item.properties)?item.properties[axis]:{});
      }
      const axis=/_(length|width|height|depth|thickness|weight)$/.exec(field)?.[1] as keyof MeasurementSet|undefined;
      if(!nested&&axis)check(axis,entry,item);
    }
    if(!components)result.supported=false;
    result.unsupported=[...new Set(result.unsupported)];record(field,result);
  }
  return {fields,issues};
}
