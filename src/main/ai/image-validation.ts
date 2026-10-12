import { evaluateImageRisk } from '../../shared/image-risk-policy.ts';
import { assertStoredImageEvidence, assertStoredListingReview } from '../listing-ai/stored-evidence.ts';
import type { AiResult } from '../../shared/ai-contracts.ts';
import type { ProductDetail } from '../../shared/contracts.ts';
import type { ImageRiskSourceSnapshot } from '../../shared/image-ai-contracts.ts';
import type { CandidateField, ListingAiContext, ListingFieldsReviewOutput } from '../../shared/listing-ai-contracts.ts';
import { LISTING_CANDIDATE_FIELDS, INFERABLE_CATEGORY_FIELDS } from '../../shared/listing-ai-contracts.ts';
import { PRODUCT_IMAGE_POLICY_VERSION, IMAGE_SET_POLICY } from '../../shared/image-ai-contracts.ts';
import type { ImageSetPlan, ImageSetSlot } from '../../shared/image-ai-contracts.ts';
import type { CandidateImageIdentity, CurrentListingCopy, GeneratedImageOcrOutput, ImagePlanOutput, ImageTextReviewOutput, ImageIpReviewOutput, ListingCurrentReviewOutput, ProductImageContext } from '../../shared/image-ai-contracts.ts';
import { assertListingEvidence, assertListingReview, listingFingerprint, validateListingContext, validateListingReviewOutput } from '../listing-ai/validation.ts';
import { AiError } from './errors.ts';
import { boundedText, date, integer, keys, sha256, uuid, validateOutput } from './validation.ts';
import { assertImageMeasurements, assertImagePromptMeasurements, imageEvidence, imageMeasurements, sourceDimensionEvidence, withoutImageMeasurements } from '../image-workflow/image-facts.ts';
import { isFullSchema,parseFullReview } from '../listing-ai/full-schema.ts';
import { explicitCategoryConflicts } from '../listing-ai/full-schema-conflicts.ts';

function fail(): never { throw new AiError('OUTPUT_INVALID'); }
/** Omission is current authorization; an explicit null selects unmarked stored v0 evidence. */
export type ImageEvidenceOptions={storedVersion?:string|null};
function list<T>(raw: unknown, max: number, parse: (raw: unknown) => T): T[] { return Array.isArray(raw) && raw.length <= max ? raw.map(parse) : fail(); }
function ids(raw: unknown): string[] { const values = list(raw, 200, value => boundedText(value, 150)); if (new Set(values).size !== values.length) fail(); return values; }
function flag(raw: unknown): boolean { return typeof raw === 'boolean' ? raw : fail(); }
function englishText(value: string): string { if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Cyrillic}\p{Script=Arabic}]/u.test(value)) fail(); return value; }
function verdict(raw: unknown): 'SUPPORTED' | 'UNSUPPORTED' | 'CONTRADICTED' { return ['SUPPORTED','UNSUPPORTED','CONTRADICTED'].includes(String(raw)) ? raw as 'SUPPORTED' | 'UNSUPPORTED' | 'CONTRADICTED' : fail(); }
export function validateCurrentListingCopy(raw: unknown,fullSchema=false): CurrentListingCopy[] {
  const copy = list(raw, fullSchema?2000:LISTING_CANDIDATE_FIELDS.length, raw => {
    const item = keys(raw, ['field','values']);
    if (fullSchema?typeof item.field!=='string'||!item.field:!LISTING_CANDIDATE_FIELDS.includes(item.field as CandidateField)) fail();
    const values = list(item.values, fullSchema?100:item.field === 'bullet_point' ? 5 : 1, value => boundedText(value, fullSchema?20000:5000));
    if (!values.length) fail();
    return { field: item.field as CandidateField, values };
  });
  if (!fullSchema&&!copy.length || new Set(copy.map(item => item.field)).size !== copy.length) fail();
  return copy;
}
function validateIpSource(raw:unknown):ImageRiskSourceSnapshot {
  const value=keys(raw,['description','originalSpec','sourceSpec','normalizedSpec','facts']);
  const facts=list(value.facts,100,raw=>{
    const fact=keys(raw,['id','name','value','source','state']);
    if(!['manual','1688','import','ai'].includes(String(fact.source))||!['source_confirmed','human_confirmed','missing','ai_suggested','conflicting'].includes(String(fact.state)))fail();
    return {id:boundedText(fact.id,100),name:boundedText(fact.name,100),value:boundedText(fact.value,4000,true),source:fact.source as ImageRiskSourceSnapshot['facts'][number]['source'],state:fact.state as ImageRiskSourceSnapshot['facts'][number]['state']};
  });
  if(new Set(facts.map(fact=>fact.id)).size!==facts.length)fail();
  return {description:boundedText(value.description,20000,true),originalSpec:boundedText(value.originalSpec,2000,true),sourceSpec:boundedText(value.sourceSpec,2000,true),normalizedSpec:boundedText(value.normalizedSpec,2000,true),facts};
}
export function imageRiskSourceSnapshot(product:ProductDetail,variantId:string):ImageRiskSourceSnapshot {
  const variant=product.variants.find(variant=>variant.id===variantId); if(!variant)throw new AiError('SOURCE_CHANGED');
  return validateIpSource({description:product.description,originalSpec:variant.originalSpec,sourceSpec:variant.sourceSpec,normalizedSpec:variant.normalizedSpec,facts:product.facts.map(({id,name,value,source,state})=>({id,name,value,source,state}))});
}
export function validateProductImageContext(raw: unknown,options:ImageEvidenceOptions={}): ProductImageContext {
  const value = keys(raw, ['listing','currentListingCopy','listingReviewResultId','referenceAssets','purpose','policyVersion'], ['ipSource','sourceVariantIds','slot','setPolicy','setPlan','referenceMeasurements','sourceMeasurements','copyReviewBypass']);
  const listing = validateListingContext(value.listing), currentListingCopy = validateCurrentListingCopy(value.currentListingCopy,isFullSchema(listing));
  if (listing.repairRequest || !['product-image/v1','product-image/vision-v2',PRODUCT_IMAGE_POLICY_VERSION].includes(String(value.policyVersion)) || !['main','detail'].includes(String(value.purpose))) fail();
  if (currentListingCopy.some(item => !listing.fields.some(field => field.name === item.field))) fail();
  let copyReviewBypass: ProductImageContext['copyReviewBypass'];
  if (value.copyReviewBypass !== undefined) {
    const bypass = keys(value.copyReviewBypass, ['policy','at','contextSha256','copySha256']);
    if (value.policyVersion !== PRODUCT_IMAGE_POLICY_VERSION || bypass.policy !== 'copy-review-disabled/v1' || bypass.contextSha256 !== listingFingerprint(listing) || bypass.copySha256 !== listingFingerprint(currentListingCopy)) fail();
    copyReviewBypass = { policy: 'copy-review-disabled/v1', at: date(bypass.at), contextSha256: sha256(bypass.contextSha256), copySha256: sha256(bypass.copySha256) };
  }
  if ((value.listingReviewResultId === null) !== Boolean(copyReviewBypass)) fail();
  if (listing.evidence.some(evidence => evidence.source === 'selected_sku' && !evidence.id.startsWith(`${listing.variantId}:`))) fail();
  const sourceVariantIds=value.sourceVariantIds===undefined?undefined:list(value.sourceVariantIds,200,uuid);
  if(sourceVariantIds&&(!sourceVariantIds.includes(listing.variantId)||new Set(sourceVariantIds).size!==sourceVariantIds.length))fail();
  const referenceAssets = list(value.referenceAssets, 10, raw => {
    const asset = keys(raw, ['assetId','sha256','variantId'],['scope']);
    if(asset.scope!==undefined&&asset.scope!=='product')fail();
    const variantId = asset.variantId === null ? null : uuid(asset.variantId);
    if (variantId !== null && !(sourceVariantIds??[listing.variantId]).includes(variantId)) fail();
    return { ...(asset.scope==='product'?{scope:'product' as const}:{}),assetId: uuid(asset.assetId), sha256: sha256(asset.sha256), variantId };
  });
  if (!referenceAssets.length || new Set(referenceAssets.map(asset => asset.assetId)).size !== referenceAssets.length || Buffer.byteLength(JSON.stringify(value)) > (isFullSchema(listing)?20*1024*1024:180000)) fail();
  if(value.policyVersion!==PRODUCT_IMAGE_POLICY_VERSION && value.ipSource!==undefined)fail();
  const ipSource=value.policyVersion===PRODUCT_IMAGE_POLICY_VERSION?validateIpSource(value.ipSource):undefined;
  let slot:ProductImageContext['slot'];if(value.slot!==undefined){const raw=keys(value.slot,['index','total','provisional']);if(raw.total!==7||raw.provisional!==true)fail();slot={index:integer(raw.index,1,7),total:7,provisional:true};if((slot.index===1)!==(value.purpose==='main'))fail();}
  if(value.setPolicy!==undefined&&(value.setPolicy!==IMAGE_SET_POLICY||value.policyVersion!==PRODUCT_IMAGE_POLICY_VERSION))fail();
  if(!value.setPolicy&&(value.setPlan!==undefined||value.referenceMeasurements!==undefined||value.sourceMeasurements!==undefined))fail();
  const sourceMeasurements=value.sourceMeasurements===undefined?undefined:list(value.sourceMeasurements,80,raw=>{
    const m=keys(raw,['id','name','value','variantId','sourceSha256']),variantId=uuid(m.variantId),id=boundedText(m.id,150),text=boundedText(m.value,1000);
    if(!(sourceVariantIds??[listing.variantId]).includes(variantId)||!id.startsWith('measurement:'+variantId+':')||!imageMeasurements(text).some(value=>value.kind==='length'&&value.value>0))fail();
    return {id,name:boundedText(m.name,100),value:text,variantId,sourceSha256:sha256(m.sourceSha256)};
  });
  if(sourceMeasurements&&new Set(sourceMeasurements.map(item=>item.id)).size!==sourceMeasurements.length)fail();
  const referenceMeasurements=value.setPolicy?list(value.referenceMeasurements,300,raw=>{
    const m=keys(raw,['id','assetId','ocrResultId','text']),assetId=uuid(m.assetId),id=boundedText(m.id,150),text=boundedText(m.text,1000);
    if(!referenceAssets.some(ref=>ref.assetId===assetId)||!id.startsWith('reference:'+assetId+':')||!imageMeasurements(text).some(value=>value.kind==='length'&&value.value>0))fail();
    return {id,assetId,ocrResultId:uuid(m.ocrResultId),text};
  }):undefined;
  if(referenceMeasurements&&new Set(referenceMeasurements.map(item=>item.id)).size!==referenceMeasurements.length)fail();
  const setPlan=value.setPlan===undefined?undefined:validateImageSetPlan(value.setPlan);
  if(value.setPolicy&&Boolean(slot)!==Boolean(setPlan))fail();
  const parsed:ProductImageContext={ listing, currentListingCopy, listingReviewResultId: value.listingReviewResultId === null ? null : uuid(value.listingReviewResultId), referenceAssets, purpose: value.purpose as 'main' | 'detail', policyVersion: value.policyVersion as ProductImageContext['policyVersion'],...(copyReviewBypass?{copyReviewBypass}:{}),...(ipSource?{ipSource}:{}),...(sourceVariantIds?{sourceVariantIds}:{}),...(slot?{slot}:{}),...(value.setPolicy?{setPolicy:IMAGE_SET_POLICY,referenceMeasurements}:{}),...(sourceMeasurements?{sourceMeasurements}:{}),...(setPlan?{setPlan}:{}) };
  if(setPlan)assertImageSetPlan(setPlan,parsed,options);
  return parsed;
}
export function validateCandidateImageIdentity(raw: unknown): CandidateImageIdentity {
  const candidate = keys(raw, ['id','sha256','width','height']);
  const width = integer(candidate.width, 16, 8191), height = integer(candidate.height, 16, 8191);
  if (Math.max(width,height) / Math.min(width,height) >= 50) fail();
  return { id: uuid(candidate.id), sha256: sha256(candidate.sha256), width, height };
}
function planPrompt(raw: unknown, max: number, empty: boolean): string {
  if (typeof raw === 'string' && !empty && !raw.trim()) throw new AiError('OUTPUT_INVALID','EMPTY_PROMPT');
  return boundedText(raw, max, empty);
}
/** Initial set planning only: the model sometimes writes all seven slot prompts and leaves the
 * outer prompt blank. Slot 1 is the main image, so its prompt is the outer prompt; the result
 * then passes every normal check. A reply with nothing to copy stays rejected, and a source
 * refusal is never given a prompt. */
export function fillSetPlanPrompt(raw: unknown, context: ProductImageContext): unknown {
  if (!context.setPolicy || context.slot || !raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const value = raw as Record<string, unknown>, set = value.setPlan;
  if (typeof value.prompt !== 'string' || value.prompt.trim() || !set || typeof set !== 'object') return raw;
  // A source refusal (sufficient:false) deliberately carries no generation instruction; keep it empty.
  const understanding = value.productUnderstanding;
  if (understanding && typeof understanding === 'object' && (understanding as Record<string, unknown>).sufficient === false) return raw;
  const slots = (set as Record<string, unknown>).slots, first: unknown = Array.isArray(slots) ? slots[0] : undefined;
  const prompt = first && typeof first === 'object' ? (first as Record<string, unknown>).prompt : undefined;
  return typeof prompt === 'string' && prompt.trim() ? { ...value, prompt } : raw;
}
function cameraFocalLength(raw:unknown):string {
  const value=boundedText(raw,50);
  if(!/^\d+(?:\.\d+)?(?:\s*(?:-|–|to)\s*\d+(?:\.\d+)?)?\s*mm$/i.test(value)||value.match(/\d+(?:\.\d+)?/g)!.some(n=>Number(n)<=0))fail();
  return value;
}
/** Recover only misplaced known members; do not reconcile competing observations. */
export function normalizeImagePlanStructure(raw:unknown):unknown {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return raw;
  const value={...raw} as Record<string,unknown>, nested=value.productUnderstanding;
  if(nested&&typeof nested==='object'&&!Array.isArray(nested)){
    const understanding={...nested} as Record<string,unknown>;
    for(const key of ['summary','referenceAssetIds','uncertainties','sufficient'])if(Object.hasOwn(value,key)){
      if(Object.hasOwn(understanding,key)&&listingFingerprint(understanding[key])!==listingFingerprint(value[key]))fail();
      understanding[key]=value[key];delete value[key];
    }
    value.productUnderstanding=understanding;
  }
  return value;
}
function planText(value:Record<string,unknown>){
  if(!['none','planned'].includes(String(value.textMode)))fail();
  const expectedText=list(value.expectedText,20,raw=>{
    const line=keys(raw,['text','evidenceIds']);
    const wrapped=line.evidenceIds;
    // Exactly [[id]] is unambiguous; mixed, duplicate and deeper arrays stay invalid.
    const normalized=Array.isArray(wrapped)&&wrapped.length===1&&Array.isArray(wrapped[0])&&wrapped[0].length===1&&typeof wrapped[0][0]==='string'?[wrapped[0][0]]:wrapped;
    return {text:englishText(boundedText(line.text,300)),evidenceIds:ids(normalized)};
  });
  if((value.textMode==='none')!==(expectedText.length===0)||new Set(expectedText.map(line=>line.text)).size!==expectedText.length)fail();
  return {textMode:value.textMode as 'none'|'planned',expectedText};
}
export function validateImagePlan(raw: unknown): ImagePlanOutput {
  const value = keys(normalizeImagePlanStructure(raw), ['kind','prompt','textMode','expectedText'], ['productUnderstanding','ipRisk','setPlan','cameraFocalLength']);
  if (value.kind !== 'image-plan' || !['none','planned'].includes(String(value.textMode))) fail();
  const {expectedText} = planText(value);
  if ((value.textMode === 'none') !== (expectedText.length === 0) || new Set(expectedText.map(line => line.text)).size !== expectedText.length) fail();
  let productUnderstanding: ImagePlanOutput['productUnderstanding'];
  if (value.productUnderstanding !== undefined) {
    const understanding = keys(value.productUnderstanding,['summary','referenceAssetIds','uncertainties','sufficient']);
    const referenceAssetIds = list(understanding.referenceAssetIds,10,uuid), uncertainties = list(understanding.uncertainties,10,item=>boundedText(item,1000)), sufficient = flag(understanding.sufficient);
    if (!referenceAssetIds.length || new Set(referenceAssetIds).size !== referenceAssetIds.length || (!sufficient && !uncertainties.length)) fail();
    productUnderstanding = {summary:boundedText(understanding.summary,1000),referenceAssetIds,uncertainties,sufficient};
  }
  let ipRisk: ImagePlanOutput['ipRisk'];
  if(value.ipRisk!==undefined) {
    const risk=keys(value.ipRisk,['verdict','findings']);
    if(!['PASS','BLOCKED','UNCERTAIN'].includes(String(risk.verdict)))fail();
    const findings=list(risk.findings,20,raw=>{
      const item=keys(raw,['category','name','evidence','referenceAssetIds']);
      if(!['character','brand','artwork','uncertain'].includes(String(item.category)))fail();
      const referenceAssetIds=list(item.referenceAssetIds,10,uuid); if(new Set(referenceAssetIds).size!==referenceAssetIds.length)fail();
      return {category:item.category as 'character'|'brand'|'artwork'|'uncertain',name:boundedText(item.name,200),evidence:boundedText(item.evidence,500),referenceAssetIds};
    });
    if(risk.verdict!=='PASS'&&!findings.length)fail();
    // A contradictory PASS must retain its risk evidence, never erase it or
    // grant clearance. The configured risk switch still controls execution.
    ipRisk={verdict:risk.verdict==='PASS'&&findings.length?'UNCERTAIN':risk.verdict as 'PASS'|'BLOCKED'|'UNCERTAIN',findings};
  }
  // A source refusal is a valid, cacheable observation, but never a generation
  // instruction. Slot prompts, source identities and all claims remain checked.
  return { kind: 'image-plan', ...(value.cameraFocalLength===undefined?{}:{cameraFocalLength:cameraFocalLength(value.cameraFocalLength)}), prompt: planPrompt(value.prompt, productUnderstanding ? 8000 : 12000, productUnderstanding?.sufficient===false), textMode: value.textMode as 'none' | 'planned', expectedText, ...(productUnderstanding ? {productUnderstanding} : {}),...(ipRisk?{ipRisk}:{}),...(value.setPlan===undefined?{}:{setPlan:validateImageSetPlan(value.setPlan,productUnderstanding?.sufficient===false)}) };
}
export function validateImageSetPlan(raw:unknown,refusal=false):ImageSetPlan{
  const value=keys(raw,['style','dimensionEvidenceIds','dimensionReason','slots']);
  const slots=list(value.slots,7,raw=>{
    const item=keys(raw,['index','role','focus','evidenceIds','scene','prompt','textMode','expectedText'],['cameraFocalLength']);
    if(!['main_scene','selling_point','dimensions','scene'].includes(String(item.role)))fail();
    const text={...planText(item),prompt:planPrompt(item.prompt,2000,refusal)};
    if(text.expectedText.length>3||text.expectedText.some(line=>line.text.length>100))fail();
    return {...(item.cameraFocalLength===undefined?{}:{cameraFocalLength:cameraFocalLength(item.cameraFocalLength)}),index:integer(item.index,1,7),role:item.role as ImageSetSlot['role'],focus:boundedText(item.focus,200),evidenceIds:ids(item.evidenceIds),scene:boundedText(item.scene,500,refusal),prompt:boundedText(text.prompt,2000,refusal),textMode:text.textMode,expectedText:text.expectedText};
  });
  if(slots.length!==7||slots.some((slot,index)=>slot.index!==index+1))fail();
  return {style:boundedText(value.style,1000),dimensionEvidenceIds:ids(value.dimensionEvidenceIds),dimensionReason:boundedText(value.dimensionReason,1000),slots};
}
export function assertImageSetPlan(plan:ImageSetPlan,context:ProductImageContext,options:ImageEvidenceOptions={},refusal=false):void{
  const sourceSizes=sourceDimensionEvidence(context),available=[...sourceSizes.map(item=>item.id),...(context.referenceMeasurements??[]).map(item=>item.id)];
  if(plan.dimensionEvidenceIds.some(id=>!available.includes(id))||!refusal&&sourceSizes.length&&!plan.dimensionEvidenceIds.length)fail();
  const dimensions=plan.slots.filter(slot=>slot.role==='dimensions');
  if(!refusal&&dimensions.length!==(plan.dimensionEvidenceIds.length?1:0))fail();
  const effective={...context,setPlan:plan},evidence=imageEvidence(effective);
  const focuses=new Set<string>(),scenes=new Set<string>();
  for(const [index,slot] of plan.slots.entries()){
    if(index===0?slot.role!=='main_scene'||slot.textMode!=='none':slot.role==='main_scene')fail();
    if(slot.evidenceIds.some(id=>!evidence.some(item=>item.id===id)))fail();
    if(!refusal&&slot.role==='selling_point'){
      const focus=normalizeText(slot.focus);
      if(slot.textMode!=='planned'||!slot.evidenceIds.length||focuses.has(focus))fail();
      focuses.add(focus);
    }
    if(!refusal&&(slot.role==='scene'||slot.role==='main_scene')){
      const scene=normalizeText(slot.scene);if(scenes.has(scene))fail();scenes.add(scene);
    }
    if(!refusal&&slot.role==='dimensions'&&(slot.textMode!=='planned'||!slot.evidenceIds.some(id=>plan.dimensionEvidenceIds.includes(id))||!slot.expectedText.some(line=>imageMeasurements(line.text).some(value=>value.kind==='length'))))fail();
    for(const line of slot.expectedText){
      if(['selling_point','dimensions'].includes(slot.role)&&!line.evidenceIds.length)fail();
      if(line.evidenceIds.some(id=>!slot.evidenceIds.includes(id)))fail();
      assertTextEvidence(line.text,line.evidenceIds,effective,options);
    }
    assertImagePromptMeasurements(slot.prompt,{evidence});
    assertImageMeasurements([slot.focus,slot.scene,...slot.expectedText.map(line=>line.text)].join('\n'),{evidence});
  }
  assertImageMeasurements(plan.style,{evidence});
}

/** Repair only new, unfrozen caption plans. Source identity and measurements are
 * never repaired by dropping evidence, and historical results remain unchanged. */
export function repairImagePlanCaptions(plan:ImagePlanOutput,context:ProductImageContext):ImagePlanOutput{
  if(plan.productUnderstanding?.sufficient===false||!context.setPolicy||context.slot||!plan.setPlan)return plan;
  const repaired=structuredClone(plan),set=repaired.setPlan!,effective={...context,setPlan:set},evidence=imageEvidence(effective);
  // Known standalone camera directions describe photography, not measured
  // product properties. Use qualitative wording before the strict size check.
  const photography=(value:string)=>value.replace(/(^|[,;；，、\n])\s*(?:consistent\s+)?\d+(?:\.\d+)?\s*mm[ -]*(?:(?:macro\s+)?lens\s+look|macro\s+look|look(?:\s+perspective)?|three-quarter\s+angle|视角)(?:\s+across\s+all\s+seven\s+images)?(?=\s*(?:[,;.；，、。\n]|$))/gi,'$1 natural photographic perspective');
  // A bare "<n>mm lens" set off as its own clause is also a camera direction, unless the
  // product evidence itself speaks of a lens or focal length; then it stays a strict fact.
  const opticalProduct=evidence.some(item=>/lens|focal|镜头|焦距/iu.test(`${item.name} ${item.value}`));
  const cameraLens=(value:string)=>opticalProduct?value:value.replace(/(^|[,;；，、\n])\s*\d+(?:\.\d+)?\s*mm[ -]*(?:(?:macro\s+)?lens|(?:微距)?镜头)(?=\s*(?:[,;.；，、。\n]|$))/gi,'$1 natural photographic perspective');
  const direction=(value:string)=>cameraLens(photography(value));
  set.style=direction(set.style);repaired.prompt=direction(repaired.prompt);
  for(const slot of set.slots){
    slot.prompt=direction(slot.prompt);
    for(const id of [...slot.evidenceIds,...slot.expectedText.flatMap(line=>line.evidenceIds)]){
      const source=evidence.find(item=>item.id===id);
      if(!source||source.source==='selected_sku'&&context.listing.variantId&&!id.startsWith(`${context.listing.variantId}:`))fail();
    }
    // Measurements, including those in rejected captions, must still be factual.
    assertImagePromptMeasurements(slot.prompt,{evidence});
    assertImageMeasurements([slot.focus,slot.scene,...slot.expectedText.map(line=>line.text)].join('\n'),{evidence});
    if(!['selling_point','scene'].includes(slot.role))continue;
    let fallback=false;
    for(const line of slot.expectedText){
      if(line.evidenceIds.some(id=>!slot.evidenceIds.includes(id)))fail();
      assertImageMeasurements(line.text,{evidence:evidence.filter(item=>line.evidenceIds.includes(item.id))});
      try{assertTextEvidence(line.text,line.evidenceIds,effective);continue;}
      catch(error){if(!(error instanceof AiError)||error.code!=='OUTPUT_INVALID')throw error;}
      // Removing an unverified gradient modifier preserves an explicitly supported
      // multicolor fact. Do not invent a replacement hue or new evidence citation.
      const simpler=/\bmulti[ -]?colou?re?d?\b/i.test(line.text)?line.text.replace(/\b(?:gradient|ombre)\b\s*/gi,'').replace(/\s+/g,' ').trim():line.text;
      if(simpler!==line.text){
        try{
          assertTextEvidence(simpler,line.evidenceIds,effective);
          for(const field of ['focus','scene','prompt'] as const)slot[field]=slot[field].replaceAll(line.text,simpler);
          line.text=simpler;continue;
        }catch(error){if(!(error instanceof AiError)||error.code!=='OUTPUT_INVALID')throw error;}
      }
      fallback=true;break;
    }
    if(fallback){
      // Rebuild the brief so an obsolete overlay or unsupported feature cannot
      // survive inside free-form prompt wording after its caption was removed.
      const angle=['front three-quarter','side','slightly elevated','low three-quarter','wide environmental','close detail'][slot.index-2]??'three-quarter';
      slot.role='scene';slot.focus='Reference product in an everyday display scene';
      slot.scene=`A simple everyday display setting with the reference product, photographed from a ${angle} angle.`;
      slot.prompt=`Photograph the exact selected SKU from the supplied reference images in a simple everyday display setting, from a ${angle} angle. Preserve its visible shape, colors and components exactly. Use natural light and an uncluttered background. No visible text, captions, labels, dimensions, logos, watermark or added accessories. Do not invent product features or imply that scene props are included.`;
      slot.evidenceIds=[];slot.textMode='none';slot.expectedText=[];
    }
  }
  const checked=validateImagePlan(repaired);assertImagePlan(checked,context);return checked;
}
export function imageIpVerdict(riskLevel: ImageIpReviewOutput['riskLevel'],labels: ImageIpReviewOutput['labels']): ImageIpReviewOutput['verdict'] {
  return evaluateImageRisk({riskLevel,labels}).verdict as ImageIpReviewOutput['verdict'];
}
export function validateImageIpReview(raw: unknown): ImageIpReviewOutput {
  const value=keys(raw,['kind','candidate','planResultId','service','verdict','riskLevel','labels']);
  if(value.kind!=='image-ip-review'||value.service!=='aigcViolationDetection'||!['none','low','medium','high'].includes(String(value.riskLevel)))fail();
  const labels=list(value.labels,100,raw=>{
    const item=keys(raw,['label','confidence','description']);
    if(item.confidence!==null && (typeof item.confidence!=='number'||!Number.isFinite(item.confidence)||item.confidence<0||item.confidence>100))fail();
    return {label:boundedText(item.label,200),confidence:item.confidence as number|null,description:boundedText(item.description,1000,true)};
  });
  if(!labels.length || new Set(labels.map(item=>item.label)).size!==labels.length)fail();
  const riskLevel=value.riskLevel as ImageIpReviewOutput['riskLevel'];
  // A stored verdict is historical evidence. Execution separately evaluates current policy.
  const legacyVerdict=riskLevel==='none'||riskLevel==='low'?'PASS':'BLOCKED';
  const historicalRefusal=riskLevel==='low'&&value.verdict==='BLOCKED'||riskLevel==='none'&&value.verdict==='UNCERTAIN';
  if(value.verdict!==imageIpVerdict(riskLevel,labels)&&value.verdict!==legacyVerdict&&!historicalRefusal)fail();
  return {kind:'image-ip-review',candidate:validateCandidateImageIdentity(value.candidate),planResultId:uuid(value.planResultId),service:'aigcViolationDetection',verdict:value.verdict as ImageIpReviewOutput['verdict'],riskLevel,labels};
}
export function validateGeneratedImageOcr(raw: unknown): GeneratedImageOcrOutput {
  const value = keys(raw, ['kind','candidate','text','lines','width','height','coordinateSpace']);
  if (value.kind !== 'generated-image-ocr') fail();
  const candidate = validateCandidateImageIdentity(value.candidate);
  const { candidate: _candidate, ...ocr } = value;
  const parsed = validateOutput({ ...ocr, kind: 'ocr' });
  if (parsed.kind !== 'ocr' || parsed.width !== candidate.width || parsed.height !== candidate.height) fail();
  return { ...parsed, kind: 'generated-image-ocr', candidate };
}
export function validateImageTextReview(raw: unknown): ImageTextReviewOutput {
  const value = keys(raw, ['kind','candidate','planResultId','ocrResultId','verdict','checks','expectedTextChecks','noTextVerified','issues','visualReview']);
  if (value.kind !== 'image-text-review' || !['PASS','NEEDS_CHANGES','BLOCKED'].includes(String(value.verdict)) || value.visualReview !== 'not_performed') fail();
  const checks = list(value.checks, 5001, raw => {
    const check = keys(raw, ['source','index','text','verdict','evidenceIds','reason']);
    if (!['summary','line'].includes(String(check.source))) fail();
    const index = integer(check.index, 0, 4999); if (check.source === 'summary' && index !== 0) fail();
    return { source: check.source as 'summary' | 'line', index, text: boundedText(check.text, 100000), verdict: verdict(check.verdict), evidenceIds: ids(check.evidenceIds), reason: boundedText(check.reason, 2000) };
  });
  const expectedTextChecks = list(value.expectedTextChecks, 20, raw => { const check = keys(raw, ['index','present','reason']); return { index: integer(check.index, 0, 19), present: flag(check.present), reason: boundedText(check.reason, 2000) }; });
  const issues = list(value.issues, 50, issue => boundedText(issue, 2000));
  if (new Set(checks.map(check => `${check.source}.${check.index}`)).size !== checks.length || new Set(expectedTextChecks.map(check => check.index)).size !== expectedTextChecks.length) fail();
  if (value.verdict === 'PASS' ? issues.length || checks.some(check => check.verdict === 'CONTRADICTED') : !issues.length) fail();
  return { kind: 'image-text-review', candidate: validateCandidateImageIdentity(value.candidate), planResultId: uuid(value.planResultId), ocrResultId: uuid(value.ocrResultId), verdict: value.verdict as ImageTextReviewOutput['verdict'], checks, expectedTextChecks, noTextVerified: flag(value.noTextVerified), issues, visualReview: 'not_performed' };
}
export function validateListingCurrentReview(raw: unknown): ListingCurrentReviewOutput {
  const value = keys(raw, ['kind','currentListingCopy','copySha256','verdict','checks','issues'],['contract']);
  if (value.kind !== 'listing-current-review') fail();
  const fullSchema=isFullSchema(value as {contract?:string});
  const currentListingCopy = validateCurrentListingCopy(value.currentListingCopy,fullSchema);
  if (listingFingerprint(currentListingCopy) !== sha256(value.copySha256)) fail();
  const parse=fullSchema?parseFullReview:validateListingReviewOutput;
  const review = parse({ kind: 'amazon-fields-review', verdict: value.verdict, checks: value.checks, issues: value.issues });
  return { ...review, kind: 'listing-current-review', currentListingCopy, copySha256: String(value.copySha256) };
}
export function assertCurrentListingReview(review: ListingFieldsReviewOutput, copy: CurrentListingCopy[], context: ListingAiContext,options:{storedVersion?:string|null}={}): void {
  if(options.storedVersion==='listing-evidence/v5'||isFullSchema(context)&&(!Object.hasOwn(options,'storedVersion')||options.storedVersion==='listing-evidence/v4')){
    const expected=copy.flatMap(item=>item.values.map((_,index)=>`${item.field}:${index}`));
    if(review.checks.length!==expected.length||new Set(review.checks.map(c=>`${c.field}:${c.index}`)).size!==expected.length||review.checks.some(c=>!expected.includes(`${c.field}:${c.index}`)))fail();
    for(const check of review.checks)for(const id of [...check.evidenceIds,...check.claims.flatMap(c=>c.evidenceIds)])if(!context.evidence.some(e=>e.id===id))fail();
    if(review.verdict==='PASS'&&(review.issues.length||review.checks.some(c=>c.verdict!=='SUPPORTED'||c.claims.some(claim=>claim.verdict!=='SUPPORTED'))))fail();
    return;
  }
  if (review.checks.length !== copy.reduce((sum,item) => sum + item.values.length, 0)) fail();
  for (const item of copy) for (const [index,value] of item.values.entries()) {
    const check = review.checks.find(check => check.field === item.field && check.index === index) ?? fail();
    if (check.evidenceIds.some(id => !context.evidence.some(evidence => evidence.id === id))) fail();
    const covered = new Array<boolean>(value.length).fill(false);
    for (const claim of check.claims) {
      if (!value.includes(claim.text) || claim.evidenceIds.some(id => !context.evidence.some(evidence => evidence.id === id))) fail();
      for (let at = value.indexOf(claim.text); at >= 0; at = value.indexOf(claim.text, at + 1)) covered.fill(true, at, at + claim.text.length);
    }
    if (/[\p{L}\p{N}]/u.test(value.split('').map((char,index) => covered[index] ? ' ' : char).join('').replace(/\b(?:a|an|the|and|or|of|for|in|with|to|on|at|is|are)\b/gi, ''))) fail();
  }
  if (review.verdict === 'PASS') {
    const candidate={kind:'amazon-fields' as const,candidates:copy.map(item=>({field:item.field,items:item.values.map((value,index)=>{
      const check=review.checks.find(check=>check.field===item.field&&check.index===index)!;
      return {value,evidenceIds:check.evidenceIds,...((INFERABLE_CATEGORY_FIELDS as readonly string[]).includes(item.field)?{transformation:'infer' as const,inferenceReason:check.reason}:{transformation:'compose' as const})};
    })})),missing:[]};
    if(Object.hasOwn(options,'storedVersion'))assertStoredListingReview(review,candidate,context,options.storedVersion??undefined);
    else assertListingReview(review,candidate,context);
  }
}
function assertTextEvidence(text: string, evidenceIds: string[], context: ProductImageContext,options:ImageEvidenceOptions={}): void {
  englishText(text);
  if(!context.setPolicy&&!evidenceIds.length)fail();
  const evidence=context.setPolicy?imageEvidence(context):context.listing.evidence;
  if(context.setPolicy)assertImageMeasurements(text,{evidence:evidence.filter(item=>evidenceIds.includes(item.id))});
  if(!Object.hasOwn(options,'storedVersion')||options.storedVersion==='listing-evidence/v4'||options.storedVersion==='listing-evidence/v5'){
    if(!context.setPolicy)assertImageMeasurements(text,{evidence:evidence.filter(item=>evidenceIds.includes(item.id))});
    if(evidenceIds.some(id=>!evidence.some(item=>item.id===id))||explicitCategoryConflicts('product_description',text,{evidence}).length)fail();
    return;
  }
  const fields = [{ name: 'product_description' as const, title: 'Image text', requirement: 'optional' as const, closedEnum: false, allowedValues: [], suggestedValues: [] }];
  const output={ kind: 'amazon-fields' as const, candidates: [{ field: 'product_description' as const, items: [{ value: context.setPolicy?withoutImageMeasurements(text):text, evidenceIds, transformation: 'compose' as const }] }], missing: [] };
  const scope={fields,evidence,variantId:context.listing.variantId,...(context.listing.evidenceBlockers?{evidenceBlockers:context.listing.evidenceBlockers}:{})};
  if(Object.hasOwn(options,'storedVersion'))assertStoredImageEvidence(output,scope,options.storedVersion??undefined);
  else assertListingEvidence(output,scope);
}
export function assertImagePlan(plan: ImagePlanOutput, context: ProductImageContext,options:ImageEvidenceOptions={}): void {
  if(context.listing.variantId&&context.listing.evidence.some(e=>e.source==='selected_sku'&&!e.id.startsWith(`${context.listing.variantId}:`)))fail();
  if (context.policyVersion !== 'product-image/v1' && (!plan.productUnderstanding || listingFingerprint(plan.productUnderstanding.referenceAssetIds) !== listingFingerprint(context.referenceAssets.map(asset=>asset.assetId)))) fail();
  if(context.policyVersion===PRODUCT_IMAGE_POLICY_VERSION && !plan.ipRisk)fail();
  if(plan.ipRisk?.findings.some(item=>item.referenceAssetIds.some(id=>!context.referenceAssets.some(asset=>asset.assetId===id))))fail();
  if (context.purpose === 'main' && plan.textMode !== 'none') fail();
  if(context.setPolicy){
    if(!context.slot){if(!plan.setPlan)fail();assertImageSetPlan(plan.setPlan,context,options,plan.productUnderstanding?.sufficient===false);}
    else{
      if(plan.setPlan||!context.setPlan)fail();
      const slot=context.setPlan.slots[context.slot.index-1];
      if(plan.textMode!==slot.textMode||listingFingerprint(plan.expectedText)!==listingFingerprint(slot.expectedText))fail();
    }
  }else if(plan.setPlan)fail();
  const evidenceContext=plan.setPlan?{...context,setPlan:plan.setPlan}:context;
  if(context.slot||context.setPolicy){
    const evidence=imageEvidence(evidenceContext);
    assertImagePromptMeasurements(plan.prompt,{evidence});
    assertImageMeasurements([imageObservationText(plan.productUnderstanding?.summary??''),...(plan.productUnderstanding?.uncertainties??[]).map(imageObservationText),...plan.expectedText.map(line=>line.text)].join('\n'),{evidence});
  }
  for (const line of plan.expectedText) assertTextEvidence(line.text, line.evidenceIds, evidenceContext,options);
}
/** Deterministic handoff keeps the product understanding alongside the original reference images. */
export function imageGenerationPrompt(plan: ImagePlanOutput,context?:ProductImageContext,riskInterceptionEnabled=true): string {
  const understanding = plan.productUnderstanding;
  if (!understanding?.sufficient || riskInterceptionEnabled&&plan.ipRisk?.verdict!=='PASS') fail();
  if(!context?.setPolicy)return imagePromptText(plan);
  assertImagePlan(plan,context);
  const slot=context.setPlan?.slots[(context.slot?.index??0)-1]??fail();
  const role=slot.role==='main_scene'?'Main image: a realistic, relevant product-use scene. The product must remain the hero.':slot.role==='selling_point'?'Feature image: exactly one selling point, using the single focus below.':slot.role==='dimensions'?'One size diagram: show only cited dimensions, label product versus package clearly.':'A distinct, relevant lifestyle scene featuring the actual product.';
  return imagePromptText({...plan,cameraFocalLength:plan.cameraFocalLength??slot.cameraFocalLength})+'\n\nMANDATORY IMAGE RULES (take precedence over creative wording):\n'+role+
    '\nPreserve the selected SKU, color, structure and supported sale quantity. Never invent accessories, functions, material, measurements or certifications. Scene props are not included items. No collage or multiple independent panels. No logos, watermarks, prices or unplanned claims.'+
    '\nSet style: '+context.setPlan!.style+'\nSingle focus: '+slot.focus+'\nScene: '+slot.scene+
    (plan.textMode==='none'?'\nNo visible text anywhere in this image: no captions, labels, signs, measurement arrows or lettering. Preserve actual product identity; do not disguise protected markings.':'\nRender only these short US English captions, clearly readable, with no extra text:\n'+plan.expectedText.map(line=>line.text).join('\n'));
}
/** Only complete, explicit packaging-exclusion observations qualify. A finite grammar
 * keeps adjacent positive claims and arbitrary prose inside the numeric list strict.
 * Use the same projection for validation and generation: excluded numbers must not
 * reach the image model as possible specifications. Stored responses stay intact.
 * Never apply this projection to creative prompts, captions, or set-plan fields. */
function imageObservationText(text:string):string {
  const dimension=String.raw`\d+(?:\.\d+)?(?:\s*[x×*]\s*\d+(?:\.\d+)?)*\s*(?:cm|mm|厘米|毫米)`;
  const dimensions=dimension+String.raw`(?:\s*(?:、|与)\s*`+dimension+String.raw`)*`;
  const counts=String.raw`(?:图上\s*\d+\s*个/盒、\s*\d+\s*个/箱、净重与毛重、)?`;
  const exclusion=String.raw`(?:箱规数值[（(]\s*`+dimensions+String.raw`\s*[）)]属于外箱包装，不可当作产品尺寸使用|`+counts+String.raw`箱规\s*`+dimensions+String.raw`\s*均为包装及整箱规格，不是单件属性，本槽不使用)`;
  const ocrExclusion=String.raw`OCR\s*中箱规[（(]\s*`+dimensions+String.raw`\s*[）)]与净重/毛重均为外箱包装数据，不用于单品尺寸图`;
  const sentence=new RegExp(String.raw`(^|[。；;\n])\s*(?:`+exclusion+'|'+ocrExclusion+String.raw`)\s*(?=[。；;\n]|$)`,'g');
  return text.replace(sentence,'$1 Excluded packaging measurements must not be used as product dimensions or rendered in the image');
}
function imagePromptText(plan:ImagePlanOutput):string{
  return `Selected SKU visual observations (not verified specifications):\n${imageObservationText(plan.productUnderstanding?.summary??'')}\n\nUncertainties to preserve; never invent missing facts:\n${plan.productUnderstanding?.uncertainties.map(imageObservationText).join('\n') || 'None reported.'}\n\nUse the attached original reference images in the supplied order. Preserve the actual product and follow these image instructions:\n${plan.prompt}${plan.cameraFocalLength?`\n\nPhotography only — camera focal length: ${cameraFocalLength(plan.cameraFocalLength)}. This describes the taking camera, never product dimensions or visible text.`:""}`;
}
const normalizeText = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function assertImageTextReview(review: ImageTextReviewOutput, context: ProductImageContext, plan: AiResult, ocr: AiResult, candidate: CandidateImageIdentity,options:ImageEvidenceOptions={}): void {
  if (plan.output.kind !== 'image-plan' || ocr.output.kind !== 'generated-image-ocr' || listingFingerprint(review.candidate) !== listingFingerprint(candidate) || listingFingerprint(ocr.output.candidate) !== listingFingerprint(candidate) || review.planResultId !== plan.id || review.ocrResultId !== ocr.id) fail();
  assertImagePlan(plan.output, context,options);
  const expected = [...(ocr.output.text.trim() ? [{ source: 'summary' as const, index: 0, text: ocr.output.text }] : []), ...ocr.output.lines.flatMap((line,index) => line.text.trim() ? [{ source: 'line' as const, index, text: line.text }] : [])];
  if (review.checks.length !== expected.length || review.expectedTextChecks.length !== plan.output.expectedText.length) fail();
  for (const line of expected) {
    const check = review.checks.find(check => check.source === line.source && check.index === line.index) ?? fail();
    if (check.text !== line.text || check.evidenceIds.some(id => !imageEvidence(context).some(evidence => evidence.id === id))) fail();
    if (check.verdict === 'SUPPORTED') assertImageMeasurements(check.text,{evidence:imageEvidence(context)},true);
  }
  const recognized = normalizeText(`${ocr.output.text}\n${ocr.output.lines.map(line => line.text).join('\n')}`);
  for (const index of plan.output.expectedText.keys()) {
    const check = review.expectedTextChecks.find(check => check.index === index) ?? fail();
    if (!context.slot&&check.present&&!recognized) fail();
  }
  if(context.setPolicy){
    const textViolation=plan.output.textMode==='none'?expected.length>0:!expected.length||review.expectedTextChecks.some(check=>!check.present);
    if(review.noTextVerified!==!expected.length)fail();
    if(review.verdict==='PASS'&&(textViolation||review.checks.some(check=>check.verdict!=='SUPPORTED')))fail();
    if(review.verdict!=='PASS'&&!textViolation&&!review.checks.some(check=>check.verdict==='UNSUPPORTED'||check.verdict==='CONTRADICTED'&&check.evidenceIds.length))fail();
    return;
  }
  if (review.verdict === 'PASS') {
    if(context.slot){if(review.checks.some(check=>check.verdict==='CONTRADICTED')||review.noTextVerified!==!expected.length)fail();return;}
    if(review.checks.some(check=>check.verdict!=='SUPPORTED'||!check.evidenceIds.length))fail();
    if (!expected.length && (plan.output.textMode !== 'none' || !review.noTextVerified)) fail();
    if (plan.output.textMode === 'none' && (expected.length || !review.noTextVerified)) fail();
    if (plan.output.textMode === 'planned' && (!expected.length || review.noTextVerified || review.expectedTextChecks.some(check => !check.present))) fail();
  }
  if(context.slot&&review.verdict!=='PASS'&&!review.checks.some(check=>check.verdict==='CONTRADICTED'&&check.evidenceIds.length))fail();
}

/** Same local validation pipeline for a new reply and an immutable retained reply. */
export function parseImagePlanResponse(raw:unknown,context:ProductImageContext):ImagePlanOutput {
  const envelope=raw&&typeof raw==='object'&&!Array.isArray(raw)&&'type' in raw&&raw.type==='json_object'?Object.fromEntries(Object.entries(raw).filter(([key])=>key!=='type')):raw;
  const plan=repairImagePlanCaptions(validateImagePlan(fillSetPlanPrompt(normalizeImagePlanStructure(envelope),context)),context);
  assertImagePlan(plan,context);return plan;
}

/** Escape only unescaped control characters inside JSON strings. No structural repair. */
export function parseImagePlanRecovery(raw:unknown,context:ProductImageContext):ImagePlanOutput {
  if(typeof raw!=='string')return parseImagePlanResponse(raw,context);
  if(Buffer.byteLength(raw,'utf8')>200000||raw.includes('[omitted:'))fail();
  let quoted=false,escaped=false,text='';
  for(const character of raw){
    if(quoted&&character.charCodeAt(0)<32){
      if(escaped)fail();
      text+='\\u'+character.charCodeAt(0).toString(16).padStart(4,'0');continue;
    }
    text+=character;
    if(escaped){escaped=false;continue;}
    if(quoted&&character==='\\'){escaped=true;continue;}
    if(character==='"')quoted=!quoted;
  }
  let value:unknown;try{value=JSON.parse(text);}catch{fail();}
  return parseImagePlanResponse(value,context);
}
