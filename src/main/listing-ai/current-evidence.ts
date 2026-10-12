import type { AiResult } from '../../shared/ai-contracts.ts';
import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { CurrentListingCopy, ProductImageContext, ImageSetPlan } from '../../shared/image-ai-contracts.ts';
import { CATEGORY_ATTRIBUTE_FIELDS } from '../../shared/listing-ai-contracts.ts';
import type { CandidateField, ListingAiContext } from '../../shared/listing-ai-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { currentCopyEvidenceIssues } from './evidence-contract-v3.ts';
import { PROSE_FIELDS, isProseField, proseEvidenceIssues } from './evidence-prose-v3.ts';
import type { ProseEvidenceIssue } from './evidence-prose-v3.ts';
import { assertListingEvidence, ListingValidationError, listingFingerprint, selectedSkuCategoryConflicts } from './validation.ts';
import { candidateTextValues } from '../amazon/field-mapping.ts';
import { imageEvidence,imageListingSnapshot } from '../image-workflow/image-facts.ts';
import { isFullSchema,nativeText,assertFullEvidence } from './full-schema.ts';
import { explicitCategoryConflicts } from './full-schema-conflicts.ts';
import { translatedFabricEvidence } from './semantic-evidence.ts';

// Current reuse only: a known affirmative material replaced by a different known
// material invalidates its old citation. Unknown or composite wording is not a conflict.
function changedMaterialCitation(old:ListingAiContext,current:ListingAiContext,ids:string[]):boolean {
  const material=(value:string):string|null=>{
    const aliases:Record<string,string>={'硅胶':'silicone','塑料':'plastic','不锈钢':'stainless steel','金属':'metal','木材':'wood','玻璃':'glass','陶瓷':'ceramic'};
    const text=(aliases[value.trim()]??translatedFabricEvidence(value)).trim().toLowerCase();
    return /^(?:silicone|plastic|stainless steel|metal|wood|glass|ceramic|cotton|polyester|nylon|wool|linen|acrylic|spandex|silk|rayon|viscose)$/.test(text)?text:null;
  };
  return ids.some(id=>{
    const before=old.evidence.find(e=>e.id===id),after=current.evidence.find(e=>e.id===id);
    if(before?.meaning!=='material'||after?.meaning!=='material')return false;
    const a=material(before.value),b=material(after.value);
    return !!a&&!!b&&a!==b&&![a,b].every(v=>['metal','stainless steel'].includes(v));
  });
}

export function currentCopyIssues(copy:CurrentListingCopy[],context:ListingAiContext):string[]{
  if(isFullSchema(context))return copy.flatMap(item=>item.values.flatMap(value=>explicitCategoryConflicts(item.field,value,context)));
  return [...currentCopyEvidenceIssues(copy,context).map(issue=>`${issue.field}：${issue.reason}`),...copy.flatMap(item=>item.values.flatMap(value=>selectedSkuCategoryConflicts(value,context.evidence,item.field).length?[`${item.field}：当前声明与所选 SKU 的明确属性冲突`]:[]))];
}
export function assertCurrentCopyEvidence(copy:CurrentListingCopy[],context:ListingAiContext):void{
  const issues=currentCopyIssues(copy,context);if(issues.length)throw new UserFacingError(issues.join('；').slice(0,2000));
}
/** Current authorization only. Keep each saved caption's actual citation IDs;
 * a missing old source cannot be replaced with an unrelated current source. */
export function assertCurrentImageCategoryExclusions(context:ListingAiContext,input:{base?:ProductImageContext;setPlan?:ImageSetPlan;plans:AiResult[]}):void{
  const plans=input.plans.flatMap(result=>result.output.kind==='image-plan'?[result.output]:[]);
  const sets=[input.base?.setPlan,input.setPlan,...plans.map(plan=>plan.setPlan)];
  const texts=[...plans.flatMap(plan=>plan.expectedText),...sets.flatMap(set=>set?.slots.flatMap(slot=>slot.expectedText)??[])];
  if(isFullSchema(context)){
    const evidence=input.base?imageEvidence({...input.base,listing:context,setPlan:input.setPlan??input.base.setPlan}):context.evidence;
    if(texts.some(line=>line.evidenceIds.some(id=>!evidence.some(e=>e.id===id))||explicitCategoryConflicts('product_description',line.text,{evidence}).length))throw new UserFacingError('当前来源无法支持旧图片文案中的引用或存在明确属性冲突');
    return;
  }
  if(texts.some(line=>proseEvidenceIssues('product_description',line.text,context,line.evidenceIds).length))throw new UserFacingError('当前来源无法支持旧图片文案中的分类声明或引用，已保留原图片与审核记录');
}
/** Known adopted AI candidates retain their original infer/citation obligations on current reuse. */
export const CONTRACT_ADOPTION_FIELDS:readonly CandidateField[]=[...CATEGORY_ATTRIBUTE_FIELDS,'target_audience','operation_mode',...PROSE_FIELDS];
type AdoptionOptions={adoptionFields?:readonly CandidateField[];adoptionContext?:'stored'};
function proseAdoptionIssues(draft:AmazonDraft,context:ListingAiContext,getResult:(id:string)=>AiResult|undefined,options:AdoptionOptions={},repairOnly=false):ProseEvidenceIssue[]{
  const owners=new Map<CandidateField,NonNullable<AmazonDraft['fieldAdoptions']>[number]>();
  // History validation establishes append order and increasing revisions. Pick
  // responsibility before validation; an invalid latest record never falls back.
  for(const adoption of draft.fieldAdoptions??[])for(const change of adoption.changes)
    if(isProseField(change.field)&&(!options.adoptionFields||options.adoptionFields.includes(change.field))&&listingFingerprint(change.after)===listingFingerprint(draft.attributes[change.field]))owners.set(change.field,adoption);
  return [...owners].flatMap(([field,adoption])=>{
    const result=getResult(adoption.suggestionResultId),change=adoption.changes.find(change=>change.field===field)!;
    const invalid=(reason:string):ProseEvidenceIssue[]=>repairOnly?[]:[{field,kind:'citation',reason}];
    if(!result||result.id!==adoption.suggestionResultId||result.output.kind!=='amazon-fields'||!result.listingContext||result.sourceSha256!==adoption.contextSha256||listingFingerprint(result.listingContext)!==adoption.contextSha256)return invalid('已采用候选的来源记录不完整');
    const candidate=result.output.candidates.find(candidate=>candidate.field===field),values=candidateTextValues(field,change.after);
    if(!candidate||!values||listingFingerprint(candidate.items.map(item=>item.value))!==listingFingerprint(values))return invalid('已采用候选与当前字段值不一致');
    const evidenceContext=options.adoptionContext==='stored'?result.listingContext:context;
    // Only a bound candidate's finite category failure can authorize this repair.
    // Record corruption or other material/color/measurement failures stay diagnostic.
    if(repairOnly)return candidate.items.flatMap(item=>proseEvidenceIssues(field,item.value,evidenceContext,item.evidenceIds));
    try{assertListingEvidence({kind:'amazon-fields',candidates:[candidate],missing:[]},evidenceContext);}
    catch(error){if(!(error instanceof ListingValidationError))throw error;return invalid(error.validationReason);}
    // The stored scope preserves image-observed color and other original proof,
    // but cannot hide a category fact present in today's deterministic projection.
    const currentIssues=candidate.items.flatMap(item=>proseEvidenceIssues(field,item.value,context,item.evidenceIds));
    if(currentIssues.length)return currentIssues;
    return [];
  });
}
/** Full-schema repair uses the same explicit attribute conflicts as final checking.
 * Legacy contexts retain their finite prose-only policy. */
export function currentProseRepairIssues(draft:AmazonDraft,context:ListingAiContext,getResult?:(id:string)=>AiResult|undefined):ProseEvidenceIssue[]{
  if(isFullSchema(context))return context.fields.flatMap(field=>{const raw=draft.attributes[field.name];return raw===undefined?[]:nativeText(field.name,raw).flatMap(value=>explicitCategoryConflicts(field.name,value,context).map(reason=>({field:field.name,kind:'source' as const,reason})));});
  const issues=context.fields.filter(field=>isProseField(field.name)).flatMap(field=>(candidateTextValues(field.name,draft.attributes[field.name])??[]).flatMap(value=>proseEvidenceIssues(field.name,value,context)));
  return [...issues,...(getResult?proseAdoptionIssues(draft,context,getResult,{},true):[])];
}
export function currentDraftEvidenceIssues(draft:AmazonDraft,context:ListingAiContext,getResult?:(id:string)=>AiResult|undefined,options:AdoptionOptions={}):string[]{
  if(isFullSchema(context)){
    const issues=currentCopyIssues(context.fields.flatMap(field=>{const raw=draft.attributes[field.name];return raw===undefined?[]:[{field:field.name,values:nativeText(field.name,raw)}];}),context);
    if(getResult)for(const adoption of draft.fieldAdoptions??[]){
      const active=adoption.changes.filter(change=>listingFingerprint(change.after)===listingFingerprint(draft.attributes[change.field]));
      if(!active.length)continue;
      const result=getResult(adoption.suggestionResultId);
      if(!result||result.output.kind!=='amazon-fields'||!result.listingContext||result.sourceSha256!==adoption.contextSha256||listingFingerprint(result.listingContext)!==adoption.contextSha256){issues.push('已采用候选的来源记录不完整');continue;}
      for(const change of active){
        const candidate=result.output.candidates.find(candidate=>candidate.field===change.field);
        if(!candidate||(Object.hasOwn(candidate,'nativeValue')?listingFingerprint(candidate.nativeValue)!==listingFingerprint(change.after):listingFingerprint(candidate.items.map(item=>item.value))!==listingFingerprint(candidateTextValues(change.field,change.after)))){issues.push(`${change.field}：已采用候选与当前字段值不一致`);continue;}
        if(options.adoptionContext!=='stored'&&changedMaterialCitation(result.listingContext,context,candidate.items.flatMap(item=>item.evidenceIds)))issues.push(`${change.field}：旧候选引用的材质与当前明确来源材质冲突`);
        try{assertFullEvidence({kind:'amazon-fields',candidates:[candidate],missing:[]},options.adoptionContext==='stored'?result.listingContext:context);}
        catch(error){if(!(error instanceof ListingValidationError))throw error;issues.push(`${change.field}：${error.validationReason}`);}
      }
    }
    return [...new Set(issues)];
  }
  const issues:string[]=[];
  const copy:CurrentListingCopy[]=context.fields.flatMap(field=>{
    const raw=draft.attributes[field.name];if(raw===undefined)return [];
    const values=candidateTextValues(field.name,raw);
    if(!values){issues.push(`${field.name}：当前字段格式不完整，无法检查来源依据`);return [];}
    return values.length?[{field:field.name,values}]:[];
  });
  // Image-only measurement filtering must not hide a finite category claim
  // still present in the actual draft. Keep the existing filtered general checks.
  issues.push(...copy.flatMap(item=>item.values.flatMap(value=>proseEvidenceIssues(item.field,value,context).map(issue=>`${issue.field}：${issue.reason}`))));
  // Completion must report malformed fields while checking the other claims.
  // Image admission still uses the strict currentImageListingSnapshot entry point.
  const snapshot=imageListingSnapshot(draft,context,copy);
  issues.push(...currentCopyIssues(snapshot.currentListingCopy,snapshot.context));
  if(getResult)issues.push(...proseAdoptionIssues(draft,context,getResult,options).map(issue=>issue.field+'：'+issue.reason));
  if(getResult)for(const adoption of draft.fieldAdoptions??[]){
    const active=adoption.changes.filter(change=>!isProseField(change.field)&&(!options.adoptionFields||options.adoptionFields.includes(change.field))&&listingFingerprint(change.after)===listingFingerprint(draft.attributes[change.field]));
    if(!active.length)continue;
    const result=getResult(adoption.suggestionResultId);
    if(!result||result.output.kind!=='amazon-fields'||!result.listingContext||result.sourceSha256!==adoption.contextSha256||listingFingerprint(result.listingContext)!==adoption.contextSha256){issues.push('已采用候选的来源记录不完整');continue;}
    // A projection without source-image observations can still check the original
    // infer obligation in its full saved scope; it cannot attest image freshness.
    const evidenceContext=options.adoptionContext==='stored'?result.listingContext:context;
    try{assertListingEvidence({kind:'amazon-fields',candidates:result.output.candidates.filter(c=>active.some(change=>change.field===c.field)),missing:[]},evidenceContext);}
    catch(error){if(!(error instanceof ListingValidationError))throw error;issues.push(`${active.map(change=>change.field).join('、')}：${error.validationReason}`);}
  }
  return [...new Set(issues)];
}

/** Current image authorization is independent of the historical listing projection. */
export function assertCurrentImageCopyEvidence(copy:CurrentListingCopy[],context:ListingAiContext):void {
  const issues=copy.flatMap(item=>item.values.flatMap(value=>explicitCategoryConflicts(item.field,value,context)));
  if(issues.length)throw new UserFacingError(issues.join('；').slice(0,2000));
}
