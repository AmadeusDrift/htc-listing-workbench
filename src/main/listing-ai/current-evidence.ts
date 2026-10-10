import type { AiResult } from '../../shared/ai-contracts.ts';
import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { CurrentListingCopy } from '../../shared/image-ai-contracts.ts';
import { CATEGORY_ATTRIBUTE_FIELDS } from '../../shared/listing-ai-contracts.ts';
import type { CandidateField, ListingAiContext } from '../../shared/listing-ai-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { currentCopyEvidenceIssues } from './evidence-contract-v1.ts';
import { assertListingEvidence, ListingValidationError, listingFingerprint, selectedSkuCategoryConflicts } from './validation.ts';
import { candidateTextValues } from '../amazon/field-mapping.ts';
import { imageListingSnapshot } from '../image-workflow/image-facts.ts';

export function currentCopyIssues(copy:CurrentListingCopy[],context:ListingAiContext):string[]{
  return [...currentCopyEvidenceIssues(copy,context).map(issue=>`${issue.field}：${issue.reason}`),...copy.flatMap(item=>item.values.flatMap(value=>selectedSkuCategoryConflicts(value,context.evidence,item.field).length?[`${item.field}：当前声明与所选 SKU 的明确属性冲突`]:[]))];
}
export function assertCurrentCopyEvidence(copy:CurrentListingCopy[],context:ListingAiContext):void{
  const issues=currentCopyIssues(copy,context);if(issues.length)throw new UserFacingError(issues.join('；').slice(0,2000));
}
/** Known adopted AI candidates retain their original infer/citation obligations on current reuse. */
export const CONTRACT_ADOPTION_FIELDS:readonly CandidateField[]=[...CATEGORY_ATTRIBUTE_FIELDS,'target_audience','operation_mode'];
export function currentDraftEvidenceIssues(draft:AmazonDraft,context:ListingAiContext,getResult?:(id:string)=>AiResult|undefined,options:{adoptionFields?:readonly CandidateField[];adoptionContext?:'stored'}={}):string[]{
  const issues:string[]=[];
  const copy:CurrentListingCopy[]=context.fields.flatMap(field=>{
    const raw=draft.attributes[field.name];if(raw===undefined)return [];
    const values=candidateTextValues(field.name,raw);
    if(!values){issues.push(`${field.name}：当前字段格式不完整，无法检查来源依据`);return [];}
    return values.length?[{field:field.name,values}]:[];
  });
  // Completion must report malformed fields while checking the other claims.
  // Image admission still uses the strict currentImageListingSnapshot entry point.
  const snapshot=imageListingSnapshot(draft,context,copy);
  issues.push(...currentCopyIssues(snapshot.currentListingCopy,snapshot.context));
  if(getResult)for(const adoption of draft.fieldAdoptions??[]){
    const active=adoption.changes.filter(change=>(!options.adoptionFields||options.adoptionFields.includes(change.field))&&listingFingerprint(change.after)===listingFingerprint(draft.attributes[change.field]));
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
