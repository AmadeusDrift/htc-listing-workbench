import { CATEGORY_FIELD_REPAIR_POLICY_VERSION } from '../../shared/automatic-listing-contracts.ts';
import type { AutomaticListingItem } from '../../shared/automatic-listing-contracts.ts';
import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { AiResult } from '../../shared/ai-contracts.ts';
import type { ListingAiContext } from '../../shared/listing-ai-contracts.ts';
import type { ImageWorkflowRun } from '../../shared/image-workflow-contracts.ts';
import { hasSevenApprovedImages } from '../../shared/image-workflow-contracts.ts';
import { imageWorkflowDraftStamp } from '../image-workflow/records.ts';
import { listingFingerprint } from './validation.ts';
import { isFullSchema } from './full-schema.ts';

export const LEGACY_THEME_REPAIR_VERSION='legacy-theme-parser/v1' as const;
export interface LegacyThemeRepair {
  version:typeof LEGACY_THEME_REPAIR_VERSION; fields:['theme']; sourceResultId:string; sourceCallId:string;
  sourceContextHash:string; sourceWorkflowId:string; originalDraftStamp:string; previousAttempts:4;
}
/** Only the finite parser's exact discarded explanation error qualifies. */
export function legacyThemeSource(draft:AmazonDraft,current:ListingAiContext,row:AutomaticListingItem,workflow:ImageWorkflowRun,results:AiResult[]):AiResult|undefined {
  if(row.legacyThemeRepair||row.repairAttempts!==4||row.repairPolicyMigration?.grantedAttempts!==1||row.sourceColorRepair?.grantedAttempts!==1
    ||row.categoryFieldPolicyVersion!==CATEGORY_FIELD_REPAIR_POLICY_VERSION||row.categoryFieldRepair||!row.imageStarted||row.repair?.phase!=='FIELDS_PENDING'
    ||row.draftId!==draft.id||row.repair.draftRevision!==draft.revision||row.repair.draftStamp!==imageWorkflowDraftStamp(draft)
    ||draft.attributes.theme!==undefined||draft.submittedAt||!['DRAFT','BLOCKED','LOCAL_VALIDATED','AMAZON_VALIDATED'].includes(draft.state)
    ||!hasSevenApprovedImages(workflow)||workflow.id!==row.repair.sourceWorkflowId)return;
  for(const key of ['draftId','productId','productRevision','variantId','sku'] as const)if(workflow[key]!== (key==='draftId'?draft.id:draft[key]))return;
  if(results.some(r=>r.output.kind==='amazon-fields'&&(r.output.candidates.some(c=>c.field==='theme')||r.output.rejectedCandidates?.some(c=>c.field==='theme'))))return;
  const result=results.filter(r=>r.output.kind==='amazon-fields').at(-1),old=result?.listingContext;
  if(!result||!old||isFullSchema(old)||result.output.kind!=='amazon-fields'||!result.output.missing.some(m=>m.field==='theme'&&m.reason==='仅推断候选可以携带推断理由；已保留其他合格字段'))return;
  const identity=['draftId','draftRevision','productId','productRevision','variantId','sku','targetId','targetGeneration','listingProgram','productType','marketplaceId','locale','requirements','parentageLevel','schemaChecksum','schemaVersion','schemaSha256','unverifiedSourceTitle','evidence'] as const;
  if(identity.some(key=>listingFingerprint(old[key]??null)!==listingFingerprint(current[key]??null)))return;
  return result;
}
