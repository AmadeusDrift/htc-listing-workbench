import type { AmazonDraft, JsonValue } from '../../shared/amazon-contracts.ts';
import type { AiResult } from '../../shared/ai-contracts.ts';
import type { ListingAiContext } from '../../shared/listing-ai-contracts.ts';
import { isObject } from '../amazon/context.ts';
import { listingFingerprint } from './validation.ts';
export interface SelectedFirmnessCorrection { version:'selected-firmness/v1'; before:JsonValue; after:JsonValue; adoptionId:string; resultId:string; contextSha256:string; selectedSpec:{id:string;value:string}; selectedSpecSha256:string }
/** Deliberately finite migration: no sentence editing, synonyms or AI authority. */
export function selectedFirmnessCorrection(draft:AmazonDraft,context:ListingAiContext,getResult:(id:string)=>AiResult|undefined):SelectedFirmnessCorrection|null {
 const before=draft.attributes.special_feature;
 if(!Array.isArray(before)||before.length!==1||!isObject(before[0])||before[0].value!=='Soft Bristles'||Object.keys(before[0]).some(k=>!['value','marketplace_id','language_tag'].includes(k)))return null;
 const selected=context.evidence.filter(e=>e.source==='selected_sku'&&e.id===`${draft.variantId}:spec`);
 if(selected.length!==1)return null;
 const spec=selected[0];
 // An explicit terminal parenthesized variant qualifier only. A mixed, negative,
 // tentative or alternatives string must continue through ordinary repair.
 if(!/^[^（）()]*[（(]硬毛[）)](?: · 1 pc)?$/.test(spec.value)||/[不非无未否软中或\/／?？]|可能|待定|随机|\b(?:not|non|no|soft|medium|maybe|unknown|or)\b/i.test(spec.value))return null;
 const owner=[...(draft.fieldAdoptions??[])].reverse().find(a=>a.changes.some(c=>c.field==='special_feature'&&listingFingerprint(c.after)===listingFingerprint(before)));
 if(!owner)return null;
 const change=owner.changes.find(c=>c.field==='special_feature')!,result=getResult(owner.suggestionResultId);
 if(!result||result.id!==owner.suggestionResultId||result.output.kind!=='amazon-fields'||!result.listingContext||result.sourceSha256!==owner.contextSha256||listingFingerprint(result.listingContext)!==owner.contextSha256)return null;
 if(['draftId','productId','variantId','sku','targetId','marketplaceId'].some(key=>result.listingContext![key as keyof ListingAiContext]!==draft[key==='draftId'?'id':key as keyof AmazonDraft]))return null;
 const candidates=result.output.candidates.filter(c=>c.field==='special_feature');if(candidates.length!==1)return null;
 const candidate=candidates[0];
 if(candidate.items.length!==1||candidate.items[0].value!=='Soft Bristles'||candidate.items[0].evidenceIds.length!==1||Object.hasOwn(candidate,'nativeValue')&&listingFingerprint(candidate.nativeValue)!==listingFingerprint(before))return null;
 const id=candidate.items[0].evidenceIds[0],evidence=result.listingContext.evidence.find(e=>e.id===id);
 if(!evidence||evidence.source!=='source_confirmed'||evidence.name!=='功能'||evidence.value!=='软毛'||change.evidence.length!==1||listingFingerprint(change.evidence[0])!==listingFingerprint(evidence))return null;
 return {version:'selected-firmness/v1',before:structuredClone(before),after:[{...before[0],value:'Hard Bristles'}],adoptionId:owner.id,resultId:result.id,contextSha256:owner.contextSha256,selectedSpec:{id:spec.id,value:spec.value},selectedSpecSha256:listingFingerprint({id:spec.id,value:spec.value})};
}
