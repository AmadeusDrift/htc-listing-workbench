import type { ValidateFunction, ErrorObject } from 'ajv';
import { createHash } from 'node:crypto';
import type { AmazonSchema, JsonValue, ListingIssue } from '../../shared/amazon-contracts.ts';
import type { ListingAiContext, ListingFieldsOutput, ListingFieldCandidate, ListingFieldsReviewOutput } from '../../shared/listing-ai-contracts.ts';
import { FULL_SCHEMA_CONTRACT } from '../../shared/listing-ai-contracts.ts';
import { ListingValidationError } from './evidence-validation-v3.ts';
import { compileAttributesSchema } from '../amazon/schema.ts';
import { candidateTextValues, wrapCandidateValues } from '../amazon/field-mapping.ts';
import { exactSkuColorIdentity } from './sku-colors.ts';
import { explicitCategoryConflicts } from './full-schema-conflicts.ts';

export const isFullSchema=(context:{contract?:string}|undefined)=>context?.contract===FULL_SCHEMA_CONTRACT;
export const evidenceVersion=(context:{contract?:string}|undefined)=>isFullSchema(context)?'listing-evidence/v4' as const:'listing-evidence/v3' as const;
const fail=(reason:string):never=>{throw new ListingValidationError(reason);};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function json(value:unknown):value is JsonValue {return value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||Array.isArray(value)&&value.every(json)||object(value)&&Object.entries(value).every(([k,v])=>!['__proto__','prototype','constructor'].includes(k)&&json(v));}
export function nativeText(field:string,value:JsonValue):string[]{
  const known=candidateTextValues(field,value);if(known)return known;
  if(typeof value==='string')return[value];
  // Structured attributes are display data, not prose or claims for image captions.
  return [];
}
export function candidateNative(candidate:ListingFieldCandidate,schema:AmazonSchema,marketplaceId:string,existing?:JsonValue):JsonValue {
  return Object.hasOwn(candidate,'nativeValue')?structuredClone(candidate.nativeValue!):wrapCandidateValues(schema,marketplaceId,candidate.field,candidate.items.map(i=>i.value),existing);
}
export function parseFullOutput(raw:unknown):ListingFieldsOutput {
  if(!object(raw)||raw.kind!=='amazon-fields'||raw.contract!==FULL_SCHEMA_CONTRACT||!Array.isArray(raw.candidates)||!Array.isArray(raw.missing))fail('完整字段响应需要 candidates 与 missing 数组');
  const candidates=((raw as Record<string,unknown>).candidates as unknown[]).map(value=>{
    if(!object(value)||typeof value.field!=='string'||!value.field||!Object.hasOwn(value,'nativeValue')||!json(value.nativeValue))fail('候选必须包含字段名与原生 JSON 值');
    const c=value as Record<string,unknown>,field=c.field as string,nativeValue=c.nativeValue as JsonValue;
    const original=Array.isArray(c.items)?c.items:[];
    const evidenceIds=c.evidenceIds??(original.length?original[0].evidenceIds:[]);
    if(!Array.isArray(evidenceIds)||evidenceIds.some(id=>typeof id!=='string')||new Set(evidenceIds).size!==evidenceIds.length)fail('来源引用格式无效');
    const transformation=c.transformation??original[0]?.transformation??'compose';
    if(!['copy','translate','compose','enum_map','infer'].includes(String(transformation)))fail('转换类型无效');
    const reason=c.inferenceReason??original[0]?.inferenceReason;
    const values=nativeText(field,nativeValue),texts=values.length?values:[JSON.stringify(nativeValue)];
    const items=texts.map(value=>({value,evidenceIds:[...evidenceIds] as string[],transformation:transformation as ListingFieldCandidate['items'][number]['transformation'],...(typeof reason==='string'?{inferenceReason:reason}:{})}));
    if(original.length&&JSON.stringify(original)!==JSON.stringify(items))fail('候选展示投影与原生值不一致');
    return {field,nativeValue:structuredClone(nativeValue),items};
  });
  const missing=((raw as Record<string,unknown>).missing as unknown[]).map(value=>{if(!object(value)||typeof value.field!=='string'||typeof value.reason!=='string')fail('未填写字段说明无效');const m=value as Record<string,unknown>;return {field:m.field as string,reason:m.reason as string};});
  const names=[...candidates,...missing].map(c=>c.field);if(new Set(names).size!==names.length)fail('候选字段重复');
  const rejectedRaw=(raw as Record<string,unknown>).rejectedCandidates;
  const rejectedCandidates=rejectedRaw===undefined?undefined:parseFullOutput({kind:'amazon-fields',contract:FULL_SCHEMA_CONTRACT,candidates:rejectedRaw,missing:[]}).candidates;
  if(rejectedCandidates?.some(candidate=>!missing.some(m=>m.field===candidate.field)))fail('被拒候选必须保留对应问题');
  return {kind:'amazon-fields',contract:FULL_SCHEMA_CONTRACT,candidates,missing,...(rejectedCandidates?.length?{rejectedCandidates}:{})};
}
/** Accept the previous text envelope as an input convenience; persist only native values. */
export function parseFullGeneration(raw:unknown,c:ListingAiContext):ListingFieldsOutput {
  if(!object(raw))fail('字段响应不是 JSON 对象');
  const root=raw as Record<string,unknown>;
  const candidates=Array.isArray(root.candidates)?root.candidates.map(value=>{
    if(!object(value)||Object.hasOwn(value,'nativeValue'))return value;
    if(typeof value.field!=='string'||!Array.isArray(value.items))return value;
    const items=value.items;
    const schema={...c, schema:c.fullSchema!.schema,metaSchema:c.fullSchema!.metaSchema,propertyGroups:{}} as unknown as AmazonSchema;
    const nativeValue=wrapCandidateValues(schema,c.marketplaceId,value.field,items.map(i=>i.value),c.currentAttributes?.[value.field]);
    return {field:value.field,nativeValue,evidenceIds:[...new Set(items.flatMap(i=>i.evidenceIds??[]))],transformation:items[0]?.transformation??'compose',...(items[0]?.inferenceReason?{inferenceReason:items[0].inferenceReason}:{})};
  }):root.candidates;
  const output=parseFullOutput({kind:'amazon-fields',contract:FULL_SCHEMA_CONTRACT,candidates,missing:root.missing??[]});
  assertFullEvidence(output,c);return output;
}
export function validateFullContext(raw:unknown):ListingAiContext {
  if(!object(raw)||raw.contract!==FULL_SCHEMA_CONTRACT||!object(raw.fullSchema)||!object(raw.fullSchema.schema)||!object(raw.fullSchema.metaSchema)||!object(raw.currentAttributes)||!object(raw.businessValues)||!object(raw.sourceProduct)||!Array.isArray(raw.fields)||!Array.isArray(raw.evidence))fail('完整 Schema 上下文不完整');
  const c=raw as unknown as ListingAiContext;
  for(const key of ['draftId','productId','variantId','targetId'] as const)if(typeof c[key]!=='string'||!/^[a-f0-9-]{36}$/i.test(c[key]))fail('上下文身份无效');
  if(!Number.isSafeInteger(c.draftRevision)||!Number.isSafeInteger(c.productRevision)||!Number.isSafeInteger(c.targetGeneration)||!/^[a-f0-9]{64}$/.test(c.schemaSha256))fail('上下文版本无效');
  if(createHash('sha256').update(JSON.stringify(c.fullSchema)).digest('hex')!==c.schemaSha256)fail('完整 Schema 与记录的规则指纹不一致');
  if(c.fields.some(f=>!f||typeof f.name!=='string')||new Set(c.fields.map(f=>f.name)).size!==c.fields.length)fail('字段目录无效');
  if(c.evidence.some(e=>!e||typeof e.id!=='string'||typeof e.value!=='string')||new Set(c.evidence.map(e=>e.id)).size!==c.evidence.length)fail('来源资料无效');
  return c;
}
export function assertFullEvidence(output:ListingFieldsOutput,context:Pick<ListingAiContext,'evidence'> & Partial<ListingAiContext>):void {
  const properties=context.fullSchema?.schema.properties;
  for(const c of output.candidates){
    if(properties&&(!object(properties)||!Object.hasOwn(properties,c.field)))fail(`Schema 未定义字段 ${c.field}`);
    for(const item of c.items)for(const id of item.evidenceIds)if(!context.evidence.some(e=>e.id===id))fail(`字段 ${c.field} 引用不存在的来源 ${id}`);
  }
  for(const m of output.missing)if(properties&&(!object(properties)||!Object.hasOwn(properties,m.field)))fail(`Schema 未定义字段 ${m.field}`);
}
export function parseFullReview(raw:unknown):ListingFieldsReviewOutput {
  if(!object(raw)||raw.kind!=='amazon-fields-review'||!['PASS','NEEDS_CHANGES','BLOCKED'].includes(String(raw.verdict))||!Array.isArray(raw.checks)||!Array.isArray(raw.issues))fail('复核格式无效');
  const result=raw as unknown as ListingFieldsReviewOutput;
  for(const check of result.checks)if(typeof check.field!=='string'||!Number.isSafeInteger(check.index)||!['SUPPORTED','UNSUPPORTED','CONTRADICTED'].includes(check.verdict)||!Array.isArray(check.evidenceIds)||!Array.isArray(check.claims))fail('复核字段格式无效');
  for(const issue of result.issues)if(typeof issue.field!=='string'||typeof issue.message!=='string')fail('复核问题格式无效');
  for(const check of result.checks)for(const claim of check.claims)if(typeof claim.text!=='string'||!['SUPPORTED','UNSUPPORTED','CONTRADICTED'].includes(claim.verdict)||!Array.isArray(claim.evidenceIds))fail('复核声明格式无效');
  if(result.verdict==='PASS'&&(result.issues.length||result.checks.some(c=>c.verdict!=='SUPPORTED'||c.claims.some(claim=>claim.verdict!=='SUPPORTED'))))fail('复核通过结论与检查结果矛盾');
  const issues=[...result.issues];
  for(const check of result.checks){
    const negative=[...(check.verdict==='SUPPORTED'?[]:[check]),...check.claims.filter(claim=>claim.verdict!=='SUPPORTED')];
    for(const finding of negative){
      const message=typeof finding.reason==='string'&&finding.reason.trim()?finding.reason:`${check.field}：复核检查为 ${finding.verdict}，需要修正或补充依据`;
      if(!issues.some(issue=>issue.field===check.field&&issue.message===message))issues.push({field:check.field,message});
    }
  }
  if(result.verdict!=='PASS'&&!issues.length)fail('复核负面结论与检查结果矛盾：缺少需要修正的问题');
  return {...result,issues,contract:FULL_SCHEMA_CONTRACT};
}
export function assertFullReview(review:ListingFieldsReviewOutput,candidate:ListingFieldsOutput,context:Pick<ListingAiContext,'evidence'> & Partial<ListingAiContext>):void {
  assertFullEvidence(candidate,context);
  const expected=candidate.candidates.flatMap(c=>c.items.map((_,index)=>`${c.field}:${index}`));
  if(review.checks.length!==expected.length||new Set(review.checks.map(c=>`${c.field}:${c.index}`)).size!==expected.length||review.checks.some(c=>!expected.includes(`${c.field}:${c.index}`)))fail('复核未覆盖全部候选');
  for(const c of review.checks)for(const id of [...c.evidenceIds,...c.claims.flatMap(claim=>claim.evidenceIds)])if(!context.evidence.some(e=>e.id===id))fail('复核引用不存在的来源');
}
const validators=new Map<string,ValidateFunction>();
function compiled(c:ListingAiContext){let v=validators.get(c.schemaSha256);if(!v){v=compileAttributesSchema(c.fullSchema!.schema,c.fullSchema!.metaSchema);if(validators.size>=32)validators.delete(validators.keys().next().value!);validators.set(c.schemaSha256,v);}return v;}
const errorKey=(e:ErrorObject)=>JSON.stringify([e.instancePath,e.schemaPath,e.keyword,e.params]);
export function nativeCandidateIssues(output:ListingFieldsOutput,c:ListingAiContext):ListingIssue[]{
  const attributes={...c.currentAttributes},names=new Set(output.candidates.map(c=>c.field)),issues:ListingIssue[]=[];
  for(const candidate of output.candidates){
    const categoryConflicts=nativeText(candidate.field,candidate.nativeValue!).flatMap(value=>explicitCategoryConflicts(candidate.field,value,c));
    for(const message of categoryConflicts)issues.push({code:'SOURCE_VALUE_CONFLICT',message,severity:'ERROR',category:'field',attributeNames:[candidate.field],source:'local',autoFixable:false});
    if(candidate.field==='color'){
      const actual=nativeText(candidate.field,candidate.nativeValue!).map(exactSkuColorIdentity).filter(Boolean);
      const observed=c.sourceProduct?.observations?.flatMap(source=>source.images.flatMap(image=>image.colors.map(exactSkuColorIdentity).filter(Boolean)))??[];
      const expected=c.evidence.filter(e=>e.meaning==='color'||e.name==='Selected SKU specification').map(e=>exactSkuColorIdentity(e.value)).filter(Boolean);
      if(actual.length&&expected.length&&new Set(expected).size===1&&actual.every(value=>!expected.includes(value)&&!observed.includes(value)))issues.push({code:'SOURCE_VALUE_CONFLICT',message:'color：候选颜色与当前 SKU 明确颜色矛盾，且没有绑定图片观察支持此修正',severity:'ERROR',category:'field',attributeNames:['color'],source:'local',autoFixable:false});
    }
    if(Object.hasOwn(c.businessValues??{},candidate.field))for(const path of changedBusinessLeaves(c.businessValues![candidate.field],candidate.nativeValue,`/${candidate.field}`))issues.push({code:'BUSINESS_VALUE_LOCKED',message:`${path}：不能覆盖已经确定的业务值`,severity:'ERROR',category:'field',attributeNames:[candidate.field],source:'local',autoFixable:false});
    attributes[candidate.field]=candidate.nativeValue!;
  }
  const validate=compiled(c);validate(c.currentAttributes);const prior=new Set((validate.errors??[]).map(errorKey));validate(attributes);
  for(const e of validate.errors??[]){
    const field=e.instancePath.split('/')[1]?.replaceAll('~1','/').replaceAll('~0','~')||String(e.params.missingProperty??e.params.additionalProperty??'');
    if(!names.has(field)&&prior.has(errorKey(e)))continue;
    issues.push({code:`LOCAL_${e.keyword}`,message:JSON.stringify({instancePath:e.instancePath,schemaPath:e.schemaPath,keyword:e.keyword,params:e.params,message:e.message}),attributeNames:field?[field]:[...names],severity:'ERROR',category:'field',source:'local',autoFixable:false});
  }
  return issues;
}
/** Keep independent valid fields; dependency failures are recomputed after each removal. */
export function retainValidNativeCandidates(output:ListingFieldsOutput,c:ListingAiContext):ListingFieldsOutput {
  const result=structuredClone(output);
  for(;;){
    const errors=[...nativeCandidateIssues(result,c),...fullCopyPolicyIssues(result)];
    if(!errors.length||!result.candidates.length)return result;
    const fields=new Set(errors.flatMap(e=>e.attributeNames)),affected=result.candidates.filter(item=>fields.has(item.field));
    const removed=affected.length?affected:result.candidates;
    for(const item of removed){const reasons=errors.filter(e=>e.attributeNames.includes(item.field));result.missing.push({field:item.field,reason:(reasons.length?reasons:errors).map(e=>`[${e.code}] ${e.message}`).join('；')});(result.rejectedCandidates??=[]).push(item);}
    result.candidates=result.candidates.filter(item=>!removed.includes(item));
  }
}
/** Approved writing rules only; all Amazon constraints use the original schema above. */
export function fullCopyPolicyIssues(output:ListingFieldsOutput):ListingIssue[]{
  const issues:ListingIssue[]=[];
  for(const candidate of output.candidates){
    const field=candidate.field;if(!['item_name','bullet_point','product_description','generic_keyword'].includes(field))continue;
    const values=nativeText(field,candidate.nativeValue!),expected=field==='bullet_point'?5:1;
    const add=(code:string,message:string)=>issues.push({code,message,attributeNames:[field],severity:'ERROR',category:'field',source:'local',autoFixable:false});
    if(values.some(value=>/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Cyrillic}\p{Script=Arabic}]/u.test(value)))add('POLICY_LANGUAGE','商品文案必须使用美国站英文');
    if(values.length!==expected)add('POLICY_VALUE_COUNT',`${field} 需要 ${expected} 条文案`);
    if(values.some(value=>!value.trim()))add('POLICY_FIELD_INVALID',`${field} 文案不能为空`);
    const max=field==='item_name'?75:field==='generic_keyword'?Infinity:500;
    if(values.some(value=>[...value].length>max))add('POLICY_MAX_LENGTH',`${field} 不能超过 ${max} 个字符`);
    if(field==='generic_keyword'&&values.some(value=>Buffer.byteLength(value)>200))add('POLICY_UTF8_LENGTH','generic_keyword 不能超过 200 UTF-8 字节');
  }
  return issues;
}
export function changedBusinessLeaves(before:JsonValue,after:JsonValue|undefined,path=''):string[]{
  if(Array.isArray(before))return before.flatMap((value,index)=>changedBusinessLeaves(value,Array.isArray(after)?after[index]:undefined,`${path}/${index}`));
  if(object(before))return Object.entries(before).flatMap(([key,value])=>changedBusinessLeaves(value as JsonValue,object(after)?after[key] as JsonValue:undefined,`${path}/${key.replaceAll('~','~0').replaceAll('/','~1')}`));
  return before===after?[]:[path];
}
