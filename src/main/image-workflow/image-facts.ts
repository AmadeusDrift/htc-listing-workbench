import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { CurrentListingCopy, ProductImageContext, ReferenceMeasurement } from '../../shared/image-ai-contracts.ts';
import type { AiResult } from '../../shared/ai-contracts.ts';
import type { ListingAiContext } from '../../shared/listing-ai-contracts.ts';
import { AiError } from '../ai/errors.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { candidateTextValues } from '../amazon/field-mapping.ts';
import { isFullSchema,nativeText } from '../listing-ai/full-schema.ts';

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
function sourceImageEvidence(context:ProductImageContext):ListingAiContext['evidence']{return [...context.listing.evidence.filter(item=>!isDefaultMeasurement(item.name)),...(context.sourceMeasurements??[]).map(({id,name,value})=>({id,name,value,meaning:'general' as const,source:'source_confirmed' as const}))];}
export function sourceDimensionEvidence(context:ProductImageContext){return sourceImageEvidence(context).filter(item=>{
  if(isDefaultMeasurement(item.name+' '+item.value)||describesOtherObject(item.name+' '+item.value))return false;
  return /尺寸|长|宽|高|厚|直径|length|width|height|diameter|dimensions?|\bsize\b|Selected SKU specification/i.test(item.name+' '+item.value)&&imageMeasurements(item.value).some(value=>value.kind==='length'&&value.value>0);
});}
const equivalent=(a:Measurement,b:Measurement)=>a.kind===b.kind&&Math.abs(a.value-b.value)<=Math.max(0.01,Math.abs(b.value)*0.015);
export function assertImageMeasurements(text:string,context:Pick<ListingAiContext,'evidence'>,onlyContradictions=false):void {
  const source=context.evidence.flatMap(item=>imageMeasurements(item.value));
  if(imageMeasurements(text).some(value=>(!onlyContradictions||source.some(actual=>actual.kind===value.kind))&&!source.some(actual=>equivalent(value,actual))))throw new AiError('OUTPUT_INVALID','UNSUPPORTED_MEASUREMENT');
}
/** Only standalone camera-look directions in generation prompts are not product measurements.
 * Keep source facts, captions and bare lens specifications on the strict measurement path. */
export function assertImagePromptMeasurements(prompt:string,context:Pick<ListingAiContext,'evidence'>):void {
  const explicitPhotography=prompt.replace(/(^|[,;.；，。\n])\s*(?:Camera(?:\s+look)?\s*:\s*\d+(?:\.\d+)?\s*mm\s+(?:macro\s+)?lens|\d+(?:\.\d+)?\s*(?:to|-|–)\s*\d+(?:\.\d+)?\s*mm\s+perspective\s+feel)(?=\s*(?:[,;.；，。\n]|$))/gi,'$1 ');
  const productText=explicitPhotography.replace(/(^|[,;\n])\s*\d+(?:\.\d+)?\s*mm\s+(?:macro\s+)?lens\s+look(?=\s*(?:[,;.\n]|$))/gi,'$1 ');
  assertImageMeasurements(productText,context);
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
