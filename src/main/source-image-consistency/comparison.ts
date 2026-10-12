import { SOURCE_COLOR_VALUES } from '../../shared/source-color-contracts.ts';
import { SOURCE_OBSERVATION_VERSION } from '../../shared/source-image-consistency-contracts.ts';
import type { SourceClaimField, SourceComparisonProjection, SourceConsistencyContext, SourceConsistencyOutput, SourceConsistencyConclusion, SourceVisualClaim } from '../../shared/source-image-consistency-contracts.ts';
import { boundedText, keys, uuid } from '../ai/validation.ts';
import { AiError } from '../ai/errors.ts';

const COLORS:Record<string,string[]>={White:['off white','off-white','white','米白','白色','白'],Black:['black','黑色','黑'],Gray:['gray','grey','灰色','灰'],Silver:['silver','银色'],Gold:['gold','金色'],Copper:['copper','铜色'],Red:['red','红色','红'],Pink:['pink','粉色'],Orange:['orange','橙色'],Yellow:['yellow','黄色','黄'],Green:['green','绿色','绿'],Blue:['blue','蓝色','蓝'],Purple:['purple','紫色'],Brown:['brown','棕色'],Beige:['beige','米色'],Clear:['clear','transparent','透明'],Multicolor:['multicolor','multi-color','多彩','彩色']};
const APPEARANCE:Record<string,string[]>={Round:['round','圆形'],Square:['square','方形'],Rectangular:['rectangular','长方形'],Oval:['oval','椭圆'],Striped:['striped','条纹'],Solid:['solid color','纯色'],PolkaDot:['polka dot','波点'],Floral:['floral','花卉']};
const enumValue=<T extends string>(raw:unknown,values:readonly T[]):T=>{if(typeof raw!=='string'||!values.includes(raw as T))throw new AiError('OUTPUT_INVALID');return raw as T;};
function matches(text:string,aliases:string[]) {
  const pattern=aliases.sort((a,b)=>b.length-a.length).map(v=>/[a-z]/i.test(v)?`(?<![a-z])${v}(?![a-z])`:v).join('|');
  return [...text.matchAll(new RegExp(pattern,'gi'))];
}
/** Finite comparison projection only: no mutation or adoption of source facts. */
export function projectSourceClaims(fields:SourceClaimField[]):SourceComparisonProjection {
  const claims:SourceVisualClaim[]=[],issues=new Set<string>();
  for(const field of fields){
    // Named nonvisual receipt attributes remain raw context, never visual claims.
    if(/^(material|fabric|size|dimensions?|weight|quantity|材质|材料|尺寸|规格尺寸|重量|数量)$/i.test(field.name.trim()))continue;
    if(/不是|并非|非(?=红|蓝|白|黑|黄|绿)|不含|无(?=条纹|花卉)|\bnot\b|\bwithout\b/i.test(field.value))issues.add('NEGATED_CLAIM');
    if(/\b[A-Z]{2,}[-]?\d{2,}[A-Z]*\b/i.test(field.value))issues.add('UNSUPPORTED_STYLE');
    if(/随机|混色|混款|随机发|random|assorted|mixed colors|\bor\b|或者|或/i.test(field.value))issues.add('RANDOM_OR_AMBIGUOUS_FULFILLMENT');
    for(const [category,map] of [['color',COLORS],['appearance',APPEARANCE]] as const){
      const tokens=Object.entries(map).flatMap(([value,aliases])=>matches(field.value,[...aliases]).map(m=>({value,raw:m[0],start:m.index!,end:m.index!+m[0].length}))).sort((a,b)=>a.start-b.start||b.end-a.end);
      let end=-1;
      for(const t of tokens){if(t.start<end||t.raw.toLowerCase()==='clear'&&/^\s+instructions\b/i.test(field.value.slice(t.end)))continue;end=t.end;const axis=category==='color'?'color':['Round','Square','Rectangular','Oval'].includes(t.value)?'shape':'pattern';claims.push({id:`${field.id}:${axis}:${t.start}`,fieldId:field.id,axis,raw:t.raw,value:t.value,start:t.start,end:t.end,rule:axis==='color'?'color-family/v1':'appearance/v1'});}
    }
    // Explicit named unknown axes cannot be hidden behind one recognizable color.
    if(/款式|型号|style|model/i.test(field.name+' '+field.value)&&!claims.some(c=>c.fieldId===field.id&&c.axis!=='color'))issues.add('UNSUPPORTED_STYLE');
    if(/颜色|colour|color/i.test(field.name+' '+field.value)&&!claims.some(c=>c.fieldId===field.id&&c.axis==='color'))issues.add('UNSUPPORTED_COLOR');
    // Only the finite visual vocabulary may authorize a match. Ignore bounded size,
    // material and packaging syntax; keep unexplained substantive spec words pending.
    // A visual/spec field needs this audit even when it yields zero known claims.
    if(claims.some(c=>c.fieldId===field.id)||/spec|规格|款式|款型|型号|style|model|shape|形状|pattern|图案|颜色|colou?r|appearance|外观/i.test(field.name)){
      let remainder=field.value;
      for(const claim of claims.filter(c=>c.fieldId===field.id).sort((a,b)=>b.start-a.start))remainder=remainder.slice(0,claim.start)+' '.repeat(claim.end-claim.start)+remainder.slice(claim.end);
      remainder=remainder.replace(/\d+(?:[.,]\d+)?\s*(?:cm|mm|inches?|inch|厘米|毫米|英寸)\b/gi,' ')
        .replace(/(?:material|fabric|材质|材料)\s*[:：=]\s*[^/;；|]+/gi,' ')
        .replace(/\b(?:silicone|plastic|rubber|cotton|polyester|metal|wood|steel|leather|solid)\b|硅胶|塑料|橡胶|棉|涤纶|金属|木质|皮革/gi,' ')
        .replace(/\b(?:size|dimensions?|color|colour|shape|pattern|spec|small|medium|large|x{0,3}[sl]|m|cm|mm|inches?|inch|pcs?|pieces?)\b|颜色|形状|图案|尺寸|规格|小号|中号|大号|厘米|毫米|英寸|个装|件装/gi,' ')
        .replace(/[\d\s.,:：;；/|()（）×x*+\-]+/g,'');
      if(/[a-z\p{Script=Han}]/iu.test(remainder))issues.add('UNSUPPORTED_STYLE');
    }

  }
  for(const axis of ['color','shape','pattern']){
    const sets=fields.map(f=>[...new Set(claims.filter(c=>c.fieldId===f.id&&c.axis===axis).map(c=>c.value))].sort().join('|')).filter(Boolean);
    if(new Set(sets).size>1)issues.add('RAW_NORMALIZED_CONFLICT');
  }
  if(!claims.length)issues.add('NO_COMPARABLE_CLAIM');
  return {fields,claims,issues:[...issues]};
}
export function validateConsistencyOutput(raw:unknown):SourceConsistencyOutput {
  try {
    if((raw as Record<string,unknown>)?.version===SOURCE_OBSERVATION_VERSION)return validateObservationOutput(raw);
    const o=keys(raw,['kind','assets']);if(o.kind!=='source-image-consistency'||!Array.isArray(o.assets)||!o.assets.length||o.assets.length>10)throw new Error();
    const assets=o.assets.map(raw=>{
      const a=keys(raw,['assetId','quality','visibility','lighting','presentation','colors','appearance','claims']);
      const list=(raw:unknown,allowed:readonly string[])=>{if(!Array.isArray(raw)||raw.length>allowed.length)throw new Error();const out=raw.map(v=>enumValue(v,allowed));if(new Set(out).size!==out.length)throw new Error();return out;};
      if(!Array.isArray(a.claims)||a.claims.length>400)throw new Error();
      const claims=a.claims.map(raw=>{const c=keys(raw,['claimId','value','visibility']);const visibility=enumValue(c.visibility,['visible','unknown']);if((visibility==='unknown')!==(c.value===null))throw new Error();return{claimId:boundedText(c.claimId,200),value:c.value===null?null:enumValue(c.value,[...SOURCE_COLOR_VALUES,...Object.keys(APPEARANCE)]),visibility};});
      if(new Set(claims.map(c=>c.claimId)).size!==claims.length)throw new Error();
      return {assetId:uuid(a.assetId),quality:enumValue(a.quality,['clear','low-detail']),visibility:enumValue(a.visibility,['complete','occluded']),lighting:enumValue(a.lighting,['neutral','uncertain']),presentation:enumValue(a.presentation,['single-product','alternatives','unknown']),colors:list(a.colors,SOURCE_COLOR_VALUES),appearance:list(a.appearance,Object.keys(APPEARANCE)),claims};
    });
    if(new Set(assets.map(a=>a.assetId)).size!==assets.length)throw new Error();
    return {kind:'source-image-consistency',assets};
  }catch{throw new AiError('OUTPUT_INVALID');}
}
export function assertConsistencyOutput(output:SourceConsistencyOutput,context:Pick<SourceConsistencyContext,'claims'|'referenceAssets'>):void {
  if(output.assets.length!==context.referenceAssets.length)throw new AiError('OUTPUT_INVALID');
  if(output.version===SOURCE_OBSERVATION_VERSION){
    if(output.assets.some(a=>!context.referenceAssets.some(ref=>ref.assetId===a.assetId)))throw new AiError('OUTPUT_INVALID');
    return;
  }
  output.assets.forEach((a,i)=>{
    if(a.assetId!==context.referenceAssets[i].assetId||a.claims.length!==context.claims.length)throw new AiError('OUTPUT_INVALID');
    a.claims.forEach((c,j)=>{const expected=context.claims[j];if(c.claimId!==expected.id||c.value!==null&&!(expected.axis==='color'?a.colors:a.appearance).includes(c.value))throw new AiError('OUTPUT_INVALID');});
  });
}
/** Host owns all verdicts; a model can only supply bounded, attributed observations. */
export function reduceSourceConsistency(projection:SourceComparisonProjection,output:SourceConsistencyOutput):SourceConsistencyConclusion {
  if(output.version===SOURCE_OBSERVATION_VERSION){
    const productReferences=new Set((projection as Partial<SourceConsistencyContext>).referenceAssets?.filter(a=>a.scope==='product').map(a=>a.assetId)??[]);
    const contradictions=projection.claims.filter(c=>output.assets.some(a=>!productReferences.has(a.assetId)&&a.quality==='clear'&&a.lighting==='neutral'&&a.presentation==='single-product'&&a.claims.some(o=>o.claimId===c.id&&o.visibility==='visible'&&o.value!==c.value))).map(c=>`VISIBLE_CONTRADICTION:${c.id}`);
    return {decision:'MATCH',reasons:['SOURCE_BINDING_REUSED',...projection.issues,...contradictions]};
  }
  const reasons=[...projection.issues];
  if(output.assets.some(a=>a.quality!=='clear'||a.visibility!=='complete'||a.lighting!=='neutral'||a.presentation!=='single-product'))reasons.push('VISUAL_UNCERTAINTY');
  if(output.assets.some(a=>a.claims.some(c=>c.visibility!=='visible')))reasons.push('CLAIM_NOT_VISIBLE');
  if(reasons.length)return{decision:'UNCERTAIN',reasons};
  const mismatches=projection.claims.filter(c=>output.assets.some(a=>a.claims.find(o=>o.claimId===c.id)?.value!==c.value)).map(c=>`VISIBLE_CONTRADICTION:${c.id}`);
  return {decision:mismatches.length?'MISMATCH':'MATCH',reasons:mismatches.length?mismatches:['SUPPORTED_VISIBLE_CLAIMS_MATCH']};
}

/** v2 stores independent, image-attributed observations; the legacy parser above stays immutable. */
function validateObservationOutput(raw:unknown):SourceConsistencyOutput {
  const o=keys(raw,['kind','version','assets']);
  if(o.kind!=='source-image-consistency'||o.version!==SOURCE_OBSERVATION_VERSION||!Array.isArray(o.assets)||!o.assets.length||o.assets.length>10)throw new AiError('OUTPUT_INVALID');
  const list=(value:unknown)=>{if(!Array.isArray(value)||value.length>100)throw new AiError('OUTPUT_INVALID');return [...new Set(value.map(v=>boundedText(v,1000)))];};
  const assets=o.assets.map(raw=>{
    const a=keys(raw,['assetId','quality','visibility','lighting','presentation','colors','appearance','claims'],['observations','contentPurpose']);
    if(!Array.isArray(a.claims)||a.claims.length>400)throw new AiError('OUTPUT_INVALID');
    const claims=a.claims.map(raw=>{const c=keys(raw,['claimId','value','visibility']),visibility=enumValue(c.visibility,['visible','unknown']);if((visibility==='unknown')!==(c.value===null))throw new AiError('OUTPUT_INVALID');return {claimId:boundedText(c.claimId,200),value:c.value===null?null:boundedText(c.value,1000),visibility};});
    let observations:NonNullable<SourceConsistencyOutput['assets'][number]['observations']>|undefined;
    if(a.observations!==undefined){if(!Array.isArray(a.observations)||a.observations.length>100)throw new AiError('OUTPUT_INVALID');observations=a.observations.map(raw=>{const v=keys(raw,['name','values','visibility']);return {name:boundedText(v.name,200),values:list(v.values),visibility:enumValue(v.visibility,['visible','unknown'])};});}
    return {assetId:uuid(a.assetId),quality:enumValue(a.quality,['clear','low-detail']),visibility:enumValue(a.visibility,['complete','occluded']),lighting:enumValue(a.lighting,['neutral','uncertain']),presentation:enumValue(a.presentation,['single-product','alternatives','unknown']),colors:list(a.colors),appearance:list(a.appearance),claims,...(a.contentPurpose===undefined?{}:{contentPurpose:enumValue(a.contentPurpose,['product','instructions-only','unknown'])}),...(observations?{observations}:{})};
  });
  if(new Set(assets.map(a=>a.assetId)).size!==assets.length)throw new AiError('OUTPUT_INVALID');
  return {kind:'source-image-consistency',version:SOURCE_OBSERVATION_VERSION,assets};
}

/** Known JSON-mode shell only. Never invent assets, values, visibility, or bindings. */
export function normalizeSourceObservations(raw:unknown,context:Pick<SourceConsistencyContext,'claims'|'referenceAssets'>):SourceConsistencyOutput {
  let diagnosticReason='SOURCE_ENVELOPE_INVALID';
  try {
  const o=keys(raw,['assets'],['kind','type','version']);
  if(o.kind!==undefined&&o.kind!=='source-image-consistency'||o.type!==undefined&&o.type!=='json_object'||o.version!==undefined&&o.version!==SOURCE_OBSERVATION_VERSION)throw new AiError('OUTPUT_INVALID');
  if(!Array.isArray(o.assets))throw new AiError('OUTPUT_INVALID');
  diagnosticReason='SOURCE_ASSET_SCHEMA_INVALID';
  const assets=o.assets.map(raw=>{const a=keys(raw,['assetId','quality','visibility','lighting','presentation'],['colors','appearance','claims','observations','contentPurpose']);return {...a,colors:a.colors??[],appearance:a.appearance??[],claims:a.claims??[]};});
  diagnosticReason='SOURCE_OBSERVATION_VALUE_INVALID';
  const output=validateConsistencyOutput({kind:'source-image-consistency',version:SOURCE_OBSERVATION_VERSION,assets});
  diagnosticReason='SOURCE_ASSET_REFERENCE_INVALID';
  assertConsistencyOutput(output,context);return output;
  }catch{const error=new AiError('OUTPUT_INVALID');error.diagnosticReason=diagnosticReason;throw error;}
}
