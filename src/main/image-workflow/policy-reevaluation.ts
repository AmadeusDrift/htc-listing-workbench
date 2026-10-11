import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { ListingAiContext } from '../../shared/listing-ai-contracts.ts';
import type { AiResult } from '../../shared/ai-contracts.ts';
import { validateAttributes } from '../amazon/schema.ts';
import { currentDraftEvidenceIssues } from '../listing-ai/current-evidence.ts';
import { isDeferredImageIssue } from './deferred-fields.ts';
export const LOCAL_LISTING_POLICY='source-union-resume/v1' as const;
/** Pure local judgment only. Preserve Amazon errors and non-evidence local rules;
 * never clear a submission receipt or invoke preview/provider operations. */
export function currentPolicyRemaining(draft:AmazonDraft,context:ListingAiContext,getResult?:(id:string)=>AiResult|undefined):string[]{
  const stale=new Set(['PROSE_SOURCE_EVIDENCE','PROSE_ADOPTION_EVIDENCE','SKU_ATTRIBUTE_CONFLICT','CONTENT_REVIEW']);
  const schema=validateAttributes(draft.schema.schema,draft.attributes,draft.schema.metaSchema);
  const issues=[...schema,...draft.localIssues.filter(issue=>!stale.has(issue.code)&&!issue.code.startsWith('LOCAL_')),...draft.previewIssues,...draft.listingIssues];
  return [...new Set([...issues.filter(issue=>issue.severity==='ERROR'&&!isDeferredImageIssue(draft,issue)).map(issue=>`${issue.attributeNames.join('、')||issue.code}：${issue.message}`),...currentDraftEvidenceIssues(draft,context,getResult)])].slice(0,100).map(value=>value.slice(0,2000));
}
