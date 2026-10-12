import { plainColorName, plainColorValue } from './plain-colors.ts';
import { isPlatformFieldIssue } from '../amazon/preview-validation.ts';
import { haulUnsupportedField } from '../amazon/listing-program.ts';
import type { ValidateFunction, ErrorObject } from 'ajv';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
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
export const imageEvidenceVersion=(context:{contract?:string}|undefined)=>isFullSchema(context)?'listing-evidence/v4' as const:'listing-evidence/v5' as const;
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
function parseNativeCandidate(value:unknown):ListingFieldCandidate {
  if(!object(value)||typeof value.field!=='string'||!value.field||!Object.hasOwn(value,'nativeValue')||!json(value.nativeValue))fail('候选必须包含字段名与原生 JSON 值');
  const c=value as Record<string,unknown>,field=c.field as string,nativeValue=c.nativeValue as JsonValue;
  const original=Array.isArray(c.items)?c.items.filter(object):[];
  const values=nativeText(field,nativeValue),texts=values.length?values:[JSON.stringify(nativeValue)];
  const projected=original.length===texts.length&&original.every((item,index)=>item.value===texts[index]);
  const items=texts.map((value,index)=>{
    const source=original[projected?index:0];
    const evidenceIds=c.evidenceIds??source?.evidenceIds??[];
    if(!Array.isArray(evidenceIds)||evidenceIds.some(id=>typeof id!=='string'))fail('来源引用格式无效');
    const raw=c.transformation??source?.transformation??'unclassified';
    const normalized=typeof raw==='string'?raw.trim().toLowerCase():'';
    const transformation=(['copy','translate','compose','enum_map','infer'].includes(normalized)?normalized:'unclassified') as ListingFieldCandidate['items'][number]['transformation'];
    const transformationOriginal=typeof source?.transformationOriginal==='string'?source.transformationOriginal:typeof raw==='string'&&raw!==transformation?raw:undefined;
    const reason=c.inferenceReason??source?.inferenceReason;
    return {value,evidenceIds:[...new Set(evidenceIds as string[])],transformation,...(transformationOriginal?{transformationOriginal}:{}),...(typeof reason==='string'?{inferenceReason:reason}:{})};
  });
  return {field,nativeValue:structuredClone(nativeValue),items,...(Array.isArray(c.normalizationNotes)?{normalizationNotes:c.normalizationNotes.filter((n):n is string=>typeof n==='string')}:{})};
}
export function parseFullOutput(raw:unknown):ListingFieldsOutput {
  if(!object(raw)||raw.kind!=='amazon-fields'||raw.contract!==FULL_SCHEMA_CONTRACT||!Array.isArray(raw.candidates)||!Array.isArray(raw.missing))fail('完整字段响应需要 candidates 与 missing 数组');
  const root=raw as Record<string,unknown>,result:ListingFieldsOutput={kind:'amazon-fields',contract:FULL_SCHEMA_CONTRACT,candidates:[],missing:[]};
  const conflicts=new Set<string>();
  for(const [index,value] of (root.candidates as unknown[]).entries()){
    try{
      const candidate=parseNativeCandidate(value),previous=result.candidates.find(c=>c.field===candidate.field);
      if(conflicts.has(candidate.field)){(result.rejectedCandidates??=[]).push(candidate);continue;}
      if(previous){
        if(isDeepStrictEqual(previous.nativeValue,candidate.nativeValue)){
          for(const item of previous.items)item.evidenceIds=[...new Set([...item.evidenceIds,...candidate.items.flatMap(i=>i.evidenceIds)])];
          const annotations=[...(candidate.normalizationNotes??[]),...candidate.items.flatMap(i=>[i.transformationOriginal,i.inferenceReason].filter((v):v is string=>typeof v==='string'))];
          if(annotations.length)previous.normalizationNotes=[...new Set([...(previous.normalizationNotes??[]),...annotations])];
          continue;
        }
        conflicts.add(candidate.field);result.candidates=result.candidates.filter(c=>c!==previous);
        (result.rejectedCandidates??=[]).push(previous,candidate);result.missing.push({field:candidate.field,reason:'[FIELD_CONFLICT] 同字段原生值冲突，已保留两个候选供核对'});continue;
      }
      result.candidates.push(candidate);
    }catch(error){result.missing.push({field:object(value)&&typeof value.field==='string'?value.field:`candidate[${index}]`,reason:`[FIELD_FORMAT] ${error instanceof ListingValidationError?error.validationReason:String(error)}；已保留其他可用字段`});}
  }
  // Even a malformed citation cannot make a different native value silently win.
  for(const value of root.candidates as unknown[]){
    if(!object(value)||typeof value.field!=='string'||!json(value.nativeValue)||conflicts.has(value.field))continue;
    const previous=result.candidates.find(c=>c.field===value.field);
    if(!previous||isDeepStrictEqual(previous.nativeValue,value.nativeValue))continue;
    const rejected=parseNativeCandidate({...value,evidenceIds:[],normalizationNotes:['原候选来源引用格式无效；原生值保留供冲突核对']});
    conflicts.add(value.field);result.candidates=result.candidates.filter(c=>c!==previous);
    (result.rejectedCandidates??=[]).push(previous,rejected);
    result.missing.push({field:value.field,reason:'[FIELD_CONFLICT] 同字段原生值冲突，已保留两个候选供核对'});
  }
  result.missing=result.missing.filter(m=>{
    const candidate=result.candidates.find(c=>c.field===m.field);
    if(!candidate)return true;(candidate.normalizationNotes??=[]).push(m.reason);return false;
  });
  for(const value of root.missing as unknown[])if(object(value)&&typeof value.field==='string'&&typeof value.reason==='string'&&!result.candidates.some(c=>c.field===value.field)&&!result.missing.some(m=>m.field===value.field))result.missing.push({field:value.field,reason:value.reason,...(value.omitted===true?{omitted:true}:{})});
  if(Array.isArray(root.rejectedCandidates))for(const value of root.rejectedCandidates){
    try{const candidate=parseNativeCandidate(value);if(result.missing.some(m=>m.field===candidate.field))(result.rejectedCandidates??=[]).push(candidate);}catch{/* Historic malformed rejected data must not discard usable fields. */}
  }
  return result;
}
/** A supplied, explicitly bound source image is its own citation, not a made-up text fact.
 * Source/context freshness and protected-field authority remain checked by their owners. */
export function fullReference(context:Pick<ListingAiContext,'evidence'> & Partial<ListingAiContext>,id:string):boolean {
  if(context.evidence.some(e=>e.id===id))return true;
  return !!context.variantId&&context.sourceProduct?.selectedSku.id===context.variantId
    &&context.sourceProduct.assets.some(asset=>asset.id===id&&asset.variantIds.includes(context.variantId!));
}
/** Resolve explicit current-SKU aliases only; never match another variant by text. */
function normalizeFullEvidence(output:ListingFieldsOutput,c:ListingAiContext):void {
  const ids=new Set(c.evidence.map(e=>e.id));
  for(const candidate of [...output.candidates]){
    const bad:string[]=[];
    for(const item of candidate.items)item.evidenceIds=[...new Set(item.evidenceIds.flatMap(id=>{
      if(fullReference(c,id))return [id];
      if((id===c.variantId||id===c.sku)&&ids.has(`${c.variantId}:spec`))return [`${c.variantId}:spec`];
      if(id.startsWith(`${c.sku}:`)){const mapped=c.variantId+id.slice(c.sku.length);if(ids.has(mapped))return [mapped];}
      bad.push(id);return [];
    }))];
    const properties=c.fullSchema?.schema.properties;
    const unknown=properties&&(!object(properties)||!Object.hasOwn(properties,candidate.field));
    if(!bad.length&&!unknown)continue;
    const reason=unknown?`Schema 未定义字段 ${candidate.field}`:`${candidate.field} 的来源引用无法对应当前规格：${[...new Set(bad)].join('、')}`;
    (candidate.normalizationNotes??=[]).push(reason);
    // A valid direct reference already supplied for this field remains usable.
    if(!unknown&&candidate.items.every(item=>item.evidenceIds.some(id=>c.evidence.some(e=>e.id===id&&(e.meaning===candidate.field||e.name===candidate.field||e.id===`${c.variantId}:spec`)))))continue;
    output.candidates=output.candidates.filter(item=>item!==candidate);
    (output.rejectedCandidates??=[]).push(candidate);
    output.missing.push({field:candidate.field,reason:`[FIELD_REFERENCE] ${reason}；待补资料，已保留其他可用字段`});
  }
}
/** Accept the previous text envelope as an input convenience; persist only native values. */
export function parseFullGeneration(raw:unknown,c:ListingAiContext):ListingFieldsOutput {
  if(!object(raw))fail('字段响应不是 JSON 对象');
  const root=raw as Record<string,unknown>;
  const candidates=Array.isArray(root.candidates)?root.candidates.map(value=>{
    if(!object(value)||Object.hasOwn(value,'nativeValue'))return value;
    if(typeof value.field!=='string'||!Array.isArray(value.items)||value.items.some(i=>!object(i)||typeof i.value!=='string'))return value;
    try{
    const items=value.items;
    const schema={...c, schema:c.fullSchema!.schema,metaSchema:c.fullSchema!.metaSchema,propertyGroups:{}} as unknown as AmazonSchema;
    const nativeValue=wrapCandidateValues(schema,c.marketplaceId,value.field,items.map(i=>i.value),c.currentAttributes?.[value.field]);
    return {field:value.field,nativeValue,evidenceIds:[...new Set(items.flatMap(i=>i.evidenceIds??[]))],transformation:items[0]?.transformation??'compose',...(items[0]?.inferenceReason?{inferenceReason:items[0].inferenceReason}:{})};
    }catch{return value;}
  }):root.candidates;
  const output=parseFullOutput({kind:'amazon-fields',contract:FULL_SCHEMA_CONTRACT,candidates,missing:root.missing??[]});
  for(const candidate of output.candidates)if(candidate.field==='color'){
    candidate.nativeValue=plainColorValue(candidate.nativeValue!,c.evidence.filter(e=>e.meaning==='color'||e.id===`${c.variantId}:spec`).map(e=>e.value));
    const values=nativeText('color',candidate.nativeValue);
    candidate.items=candidate.items.map((item,index)=>({...item,value:values[index]??item.value}));
  }
  normalizeFullEvidence(output,c);assertFullEvidence(output,c);return output;
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
    for(const item of c.items)for(const id of item.evidenceIds)if(!fullReference(context,id))fail(`字段 ${c.field} 引用不存在的来源 ${id}`);
  }

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
  for(const c of review.checks)for(const id of [...c.evidenceIds,...c.claims.flatMap(claim=>claim.evidenceIds)])if(!fullReference(context,id))fail('复核引用不存在的来源');
}
const validators=new Map<string,ValidateFunction>();
function compiled(c:ListingAiContext){let v=validators.get(c.schemaSha256);if(!v){v=compileAttributesSchema(c.fullSchema!.schema,c.fullSchema!.metaSchema);if(validators.size>=32)validators.delete(validators.keys().next().value!);validators.set(c.schemaSha256,v);}return v;}
const errorKey=(e:ErrorObject)=>JSON.stringify([e.instancePath,e.schemaPath,e.keyword,e.params]);
function compositionFields(error:ErrorObject,schema:unknown):string[]|undefined {
  if(!['if','anyOf','oneOf','allOf','not'].includes(error.keyword))return undefined;
  let node:unknown=schema;
  for(const part of error.schemaPath.replace(/^#\//,'').split('/')){
    if(!node||typeof node!=='object')return [];
    node=(node as Record<string,unknown>)[part.replaceAll('~1','/').replaceAll('~0','~')];
  }
  const fields=new Set<string>(),visited=new Set<object>();
  const visit=(value:unknown):void=>{
    if(!value||typeof value!=='object'||visited.has(value))return;visited.add(value);
    if(Array.isArray(value)){value.forEach(visit);return;}if(!object(value))return;
    if(object(value.properties))Object.keys(value.properties).forEach(name=>fields.add(name));
    if(Array.isArray(value.required))value.required.forEach(name=>{if(typeof name==='string')fields.add(name);});
    if(object(value.dependentRequired))for(const [key,names] of Object.entries(value.dependentRequired)){fields.add(key);if(Array.isArray(names))names.forEach(name=>{if(typeof name==='string')fields.add(name);});}
    for(const key of ['if','then','else','anyOf','oneOf','allOf','not'])visit(value[key]);
    if(typeof value.$ref==='string'&&value.$ref.startsWith('#/')){let ref:unknown=schema;for(const part of value.$ref.slice(2).split('/'))ref=object(ref)?ref[part.replaceAll('~1','/').replaceAll('~0','~')]:undefined;if(ref!==value)visit(ref);}
  };
  visit(node);return [...fields];
}
export function nativeCandidateIssues(output:ListingFieldsOutput,c:ListingAiContext):ListingIssue[]{
  const candidates=output.candidates.filter(candidate=>!haulUnsupportedField(c.listingProgram,candidate.field));
  const attributes={...c.currentAttributes},names=new Set(candidates.map(c=>c.field)),issues:ListingIssue[]=[];
  for(const candidate of candidates){
    const categoryConflicts=nativeText(candidate.field,candidate.nativeValue!).flatMap(value=>explicitCategoryConflicts(candidate.field,value,c));
    for(const message of categoryConflicts)issues.push({code:'SOURCE_VALUE_CONFLICT',message,severity:'ERROR',category:'field',attributeNames:[candidate.field],source:'local',autoFixable:false});
    if(candidate.field==='color'){
      const identity=(value:string)=>exactSkuColorIdentity(plainColorName(value).replace(/([a-z])([A-Z])/g,'$1 $2'));
      const actual=nativeText(candidate.field,candidate.nativeValue!).map(identity).filter(Boolean);
      const observed=c.sourceProduct?.observations?.flatMap(source=>source.images.filter(image=>!source.productReferenceAssetIds?.includes(image.assetId)).flatMap(image=>image.colors.map(identity).filter(Boolean)))??[];
      const expected=c.evidence.filter(e=>e.meaning==='color'||e.name==='Selected SKU specification').map(e=>identity(e.value)).filter(Boolean);
      if(actual.length&&expected.length&&new Set(expected).size===1&&actual.every(value=>!expected.includes(value)&&!observed.includes(value)))issues.push({code:'SOURCE_VALUE_CONFLICT',message:'color：候选颜色与当前 SKU 明确颜色矛盾，且没有绑定图片观察支持此修正',severity:'ERROR',category:'field',attributeNames:['color'],source:'local',autoFixable:false});
    }
    if(Object.hasOwn(c.businessValues??{},candidate.field))for(const path of changedBusinessLeaves(c.businessValues![candidate.field],candidate.nativeValue,`/${candidate.field}`))issues.push({code:'BUSINESS_VALUE_LOCKED',message:`${path}：不能覆盖已经确定的业务值`,severity:'ERROR',category:'field',attributeNames:[candidate.field],source:'local',autoFixable:false});
    attributes[candidate.field]=candidate.nativeValue!;
  }
  const validate=compiled(c);validate(c.currentAttributes);const prior=new Set((validate.errors??[]).map(errorKey));validate(attributes);
  for(const e of validate.errors??[]){
    const field=e.instancePath.split('/')[1]?.replaceAll('~1','/').replaceAll('~0','~')||String(e.params.missingProperty??e.params.additionalProperty??'');
    if(!names.has(field)&&prior.has(errorKey(e)))continue;
    const issue:ListingIssue={code:`LOCAL_${e.keyword}`,message:JSON.stringify({instancePath:e.instancePath,schemaPath:e.schemaPath,keyword:e.keyword,params:e.params,message:e.message}),attributeNames:e.keyword==='dependentRequired'?[String(e.params.property)]:field?[field]:compositionFields(e,c.fullSchema!.schema)??[...names],severity:'ERROR',category:'field',source:'local',autoFixable:false};
    if(!isPlatformFieldIssue(c.listingProgram,issue))issues.push(issue);
  }
  return issues;
}
/** Keep independent valid fields; dependency failures are recomputed after each removal. */
export function retainValidNativeCandidates(output:ListingFieldsOutput,c:ListingAiContext):ListingFieldsOutput {
  const result=structuredClone(output);
  for(;;){
    const errors=[...nativeCandidateIssues(result,c),...fullCopyPolicyIssues(result)];
    if(!errors.length||!result.candidates.length)return markOptionalOmissions(result,c);
    const fields=new Set(errors.flatMap(e=>e.attributeNames)),affected=result.candidates.filter(item=>fields.has(item.field));
    if(!affected.length)return markOptionalOmissions(result,c);
    const removed=affected;
    for(const item of removed){const reasons=errors.filter(e=>e.attributeNames.includes(item.field));result.missing.push({field:item.field,reason:(reasons.length?reasons:errors).map(e=>`[${e.code}] ${e.message}`).join('；')});(result.rejectedCandidates??=[]).push(item);}
    result.candidates=result.candidates.filter(item=>!removed.includes(item));
  }
}
/** Omitted optional suggestions are diagnostics, not a reason to repair the product. */
function markOptionalOmissions(output:ListingFieldsOutput,c:ListingAiContext):ListingFieldsOutput {
  const attributes={...c.currentAttributes};for(const candidate of output.candidates)attributes[candidate.field]=candidate.nativeValue!;
  const validate=compiled(c);validate(attributes);
  const blocking=new Set((validate.errors??[]).flatMap(e=>[e.instancePath.split('/')[1]?.replaceAll('~1','/').replaceAll('~0','~'),String(e.params.missingProperty??'')]));
  for(const issue of c.repairRequest?.issues??[])blocking.add(issue.field);
  for(const field of c.fields)if(field.requirement==='required')blocking.add(field.name);
  output.missing=output.missing.map(m=>{const {omitted,...rest}=m;return blocking.has(m.field)?rest:{...rest,omitted:true};});
  return output;
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
