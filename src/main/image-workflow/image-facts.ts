import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { CurrentListingCopy, ProductImageContext, ReferenceMeasurement } from '../../shared/image-ai-contracts.ts';
import type { AiResult } from '../../shared/ai-contracts.ts';
import type { ListingAiContext } from '../../shared/listing-ai-contracts.ts';
import { AiError } from '../ai/errors.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { candidateTextValues } from '../amazon/field-mapping.ts';
import { isFullSchema, nativeText } from "../listing-ai/native-values.ts";

type Measurement = { kind:'length'|'weight'; value:number };
const measurementPattern=()=>/(\d+(?:\.\d+)?(?:\s*[x×*]\s*\d+(?:\.\d+)?)*)\s*(millimeters?|centimeters?|毫米|厘米|千克|公斤|英寸|inches|inch|ounces|ounce|pounds|pound|grams|gram|mm|cm|kg|lbs|lb|oz|in|g|m|克|米)(?![a-z])/gi;
export const withoutImageMeasurements=(text:string)=>text.replace(measurementPattern(),' ');
export const isDefaultMeasurement=(name:string)=>/(?:业务默认|自动填充|默认尺寸|listing default|fallback|placeholder)/i.test(name);
export const describesOtherObject=(text:string)=>/(?:兼容|适配|适用|适合|容纳|场景|参照|compatib|\bfits?\b|\bfor\b|reference object)/i.test(text);
/** Canonical units are cm and grams; rendering precision is not a factual contradiction. */
export function imageMeasurements(text:string):Measurement[] {
  const values:Measurement[]=[];
  const units:Record<string,[Measurement['kind'],number]>={mm:['length',0.1],毫米:['length',0.1],cm:['length',1],厘米:['length',1],m:['length',100],米:['length',100],in:['length',2.54],inch:['length',2.54],inches:['length',2.54],'英寸':['length',2.54],g:['weight',1],gram:['weight',1],grams:['weight',1],克:['weight',1],kg:['weight',1000],千克:['weight',1000],公斤:['weight',1000],oz:['weight',28.349523125],ounce:['weight',28.349523125],ounces:['weight',28.349523125],lb:['weight',453.59237],lbs:['weight',453.59237],pound:['weight',453.59237],pounds:['weight',453.59237]};
  const pattern=measurementPattern();
  for(const match of text.matchAll(pattern)) {
    const key=match[2].toLowerCase().replace(/^millimeters?$/,'mm').replace(/^centimeters?$/,'cm'),unit=units[key];
    if(unit)for(const number of match[1].split(/\s*[x×*]\s*/))values.push({kind:unit[0],value:Number(number)*unit[1]});
  }
  return values;
}
/** No inferred scale: retain only explicit number + unit text from a source-image OCR result. */
export function referenceMeasurementEvidence(result:AiResult):ReferenceMeasurement[]{
  if(result.output.kind!=='ocr'||!result.assetId)return [];
  const texts=result.output.lines.length?result.output.lines.map(line=>line.text):result.output.text.split(/[\r\n]+/);
  return [...new Set(texts.map(text=>text.trim()).filter(text=>text.length<=1000&&imageMeasurements(text).some(value=>value.kind==='length'&&value.value>0)))].slice(0,30).map((text,index)=>({id:`reference:${result.assetId}:${index}`,assetId:result.assetId!,ocrResultId:result.id,text}));
}
/** Image-local measurement citations; never written into product facts or listing evidence. */
export function imageEvidence(context:ProductImageContext):ListingAiContext['evidence']{
  const selected=new Set(context.setPlan?.dimensionEvidenceIds??[]);
  return [...sourceImageEvidence(context),...(context.referenceMeasurements??[]).filter(item=>selected.has(item.id)).map(item=>({id:item.id,name:'Printed dimensions in source image (OCR + visual reading)',value:item.text,meaning:'general' as const,source:'source_confirmed' as const}))];
}
function sourceImageEvidence(context:ProductImageContext):ListingAiContext['evidence']{return [...context.listing.evidence.filter(item=>!isDefaultMeasurement(item.name)&&!(describesOtherObject(item.name+' '+item.value)&&imageMeasurements(item.value).length)),...(context.sourceMeasurements??[]).map(({id,name,value})=>({id,name,value,meaning:'general' as const,source:'source_confirmed' as const}))];}
/** Scope is read from retained source labels/identity, never inferred from numeric values. */
export function imageMeasurementScope(item:{id:string;name?:string;value?:string;text?:string}):'product'|'package'|'component'|'unknown'{
  const text=[item.name,item.value,item.text].filter(Boolean).join(' ');
  if(/^measurement:[^:]+:package\./.test(item.id)||/(?:包装|箱规|外箱|\bpackag(?:e|ing)\b|\bcarton\b)/i.test(text))return 'package';
  if(/(?:组件|配件|\bcomponent\b)/i.test(text))return 'component';
  if(/^measurement:[^:]+:item\./.test(item.id)||/(?:商品|产品|本体|\b(?:product|item|body)\b|Selected SKU specification)/i.test(text))return 'product';
  return 'unknown';
}
/** Optional size diagrams may cite scoped packaging; only body measurements require one. */
export function availableDimensionEvidence(context:ProductImageContext){return sourceImageEvidence(context).filter(item=>{
  if(isDefaultMeasurement(item.name+' '+item.value)||describesOtherObject(item.name+' '+item.value))return false;
  return /尺寸|长|宽|高|厚|直径|length|width|height|diameter|dimensions?|\bsize\b|Selected SKU specification/i.test(item.name+' '+item.value)&&imageMeasurements(item.value).some(value=>value.kind==='length'&&value.value>0);
});}
export function sourceDimensionEvidence(context:ProductImageContext){return availableDimensionEvidence(context).filter(item=>imageMeasurementScope(item)==='product');}
const equivalent=(a:Measurement,b:Measurement)=>a.kind===b.kind&&Math.abs(a.value-b.value)<=Math.max(0.01,Math.abs(b.value)*0.015);
/** A package/component number cannot silently become a body size in a caption or prompt.
 * Check individual clauses so a distant package label cannot bless an unrelated claim. */
export function imageMeasurementScopeValid(text:string,evidence:ListingAiContext['evidence']):boolean{
  return text.split(/[;；。\n]|(?<!\d)\.(?!\d)/).every(clause=>imageMeasurements(clause).every(measurement=>{
    const matches=evidence.filter(item=>imageMeasurements(item.value).some(actual=>equivalent(measurement,actual)));
    if(!matches.length||matches.some(item=>['product','unknown'].includes(imageMeasurementScope(item))))return true; // Numeric support and corroborated OCR selection are checked separately.
    const scopes=matches.map(imageMeasurementScope);
    return scopes.includes('package')&&/\bpackag(?:e|ing)\b|\bcarton\b|包装|箱规|外箱/i.test(clause)&&!/(?:\b(?:product|item|body)\s+(?:size|dimensions?|length|width|height|diameter)|(?:产品|商品|本体)(?:尺寸|长|宽|高|直径))/i.test(clause)
      ||scopes.includes('component')&&/\bcomponent\b|组件|配件/i.test(clause)&&!/(?:\b(?:product|item|body)\s+(?:size|dimensions?|length|width|height|diameter)|(?:产品|商品|本体)(?:尺寸|长|宽|高|直径))/i.test(clause);
  }));
}
export function assertImageMeasurements(text:string,context:Pick<ListingAiContext,'evidence'>,onlyContradictions=false):void {
  const source=context.evidence.flatMap(item=>imageMeasurements(item.value));
  if(imageMeasurements(text).some(value=>(!onlyContradictions||source.some(actual=>actual.kind===value.kind))&&!source.some(actual=>equivalent(value,actual))))throw new AiError('OUTPUT_INVALID','UNSUPPORTED_MEASUREMENT');
}
/** Only standalone camera-look directions in generation prompts are not product measurements.
 * Keep source facts, captions and bare lens specifications on the strict measurement path. */
export function assertImagePromptMeasurements(prompt:string,context:Pick<ListingAiContext,'evidence'>):void {
  // Parse complete camera-direction clauses, never strip all occurrences of a focal
  // number. Bare lens/product specifications and adjacent dimensions stay factual.
  const focal=String.raw`\d+(?:\.\d+)?(?:\s*(?:to|-|–)\s*\d+(?:\.\d+)?)?\s*mm`;
  const modifier=String.raw`(?:macro(?:-style)?\s+)?`;
  const look=String.raw`(?:perspective(?:\s+feel)?|look|lens\s+look)`;
  const direction=String.raw`(?:Camera(?:\s+look)?\s*:\s*`+focal+String.raw`\s+`+modifier+String.raw`(?:lens|`+look+String.raw`)|Camera\s+look\s+of\s+(?:an?\s+)?`+focal+String.raw`\s+`+modifier+String.raw`lens|`+focal+String.raw`\s+`+modifier+look+String.raw`)`;
  const clause=new RegExp(String.raw`(^|[,;；，。\n]|(?<!\d)\.(?!\d))\s*`+direction+String.raw`(?=\s*(?:[,;.；，。\n]|$))`,'gi');
  assertImageMeasurements(withoutRenderExclusions(prompt.replace(clause,'$1 ')),context);
}
/** Defaults are listing-only. Source measurements keep their original evidence and authority. */
export function imageListingSnapshot(draft:AmazonDraft,listing:ListingAiContext,copy:CurrentListingCopy[]):{context:ListingAiContext;currentListingCopy:CurrentListingCopy[]} {
  const fallback=new Set<Measurement['kind']>();
  for(const [field,entry] of Object.entries(draft.businessRules?.fields??{}))if(entry.reason.includes('业务默认')&&JSON.stringify(entry.value)===JSON.stringify(draft.attributes[field])){
    if(/dimension|length|width|height/.test(field))fallback.add('length');if(/weight/.test(field))fallback.add('weight');
  }
  const context=structuredClone(listing);
  context.evidence=context.evidence.filter(item=>!isDefaultMeasurement(item.name));
  const actual=context.evidence.flatMap(item=>imageMeasurements(item.value));
  const clean=(text:string)=>text.split(/(?<=[.!?;。；])\s+/).filter(sentence=>!imageMeasurements(sentence).some(value=>fallback.has(value.kind)&&!actual.some(source=>equivalent(value,source)))).join(' ').trim();
  return {context,currentListingCopy:copy.flatMap(item=>{const values=item.values.map(clean).filter(Boolean);return values.length?[{field:item.field,values}]:[];})};
}
/** The independent review and resume checks must derive the exact same filtered copy. */
export function currentImageListingSnapshot(draft:AmazonDraft,context:ListingAiContext):{context:ListingAiContext;currentListingCopy:CurrentListingCopy[]}{
  const copy=context.fields.flatMap(field=>{
    const raw=draft.attributes[field.name];if(raw===undefined)return [];
    const values=isFullSchema(context)?nativeText(field.name,raw):candidateTextValues(field.name,raw);
    if(!values)throw new UserFacingError('当前文案字段格式不完整，不能开始图片审核');
    return values.length?[{field:field.name,values}]:[];
  });
  return imageListingSnapshot(draft,context,copy);
}

/** Exclusions are not factual claims. Only a complete negative rendering clause is removed;
 * arbitrary adjacent prose remains on the strict measurement validation path. */
export function withoutRenderExclusions(text:string):string {
  const measurement=measurementPattern().source; // Same complete units and suffix boundary as positive claims.
  const exclusion=String.raw`(?:(?:do\s+not|never)\s+(?:render|draw|show|display|label|print)\s+(?:(?:product|package)\s+)?(?:weight|dimensions?|size|length|width|height)\s*[:：]?\s*|(?:不要|禁止|不)(?:绘制|画|显示|标注|呈现)(?:商品|产品|包装)?(?:重量|尺寸|长度|宽度|高度)\s*[:：]?\s*)`+measurement;
  return text.replace(new RegExp(String.raw`(^|[,，;；。\n]|(?<!\d)\.(?!\d))\s*`+exclusion+String.raw`\s*(?=$|[,，;；。\n]|(?<!\d)\.(?!\d))`,'gi'),'$1 Excluded unverified measurement');
}
