import type { ListingAiContext, ListingFieldsOutput } from '../../shared/listing-ai-contracts.ts';
import { isFullSchema, parseFullReview, assertFullReview, fullReference } from './full-schema.ts';
import { validateListingReviewOutput, assertListingEvidence } from './validation.ts';
import { requireCompleteReview } from './review-coverage.ts';

/** Classifies failure only; never creates review evidence, PASS, or replacement copy. */
export function isReviewCoverageOmission(raw:unknown,candidate:ListingFieldsOutput,context:ListingAiContext):boolean {
  try {
    assertListingEvidence(candidate,context);
    const full=isFullSchema(context),review=full?parseFullReview(raw):validateListingReviewOutput(raw);
    if(review.verdict!=='PASS'||review.issues.length||review.checks.some(c=>c.verdict!=='SUPPORTED'||c.claims.some(v=>v.verdict!=='SUPPORTED')))return false;
    const expected=candidate.candidates.flatMap(c=>c.items.map((item,index)=>({field:c.field,index,value:item.value})));
    const keys=new Set<string>();
    for(const check of review.checks){
      const key=`${check.field}:${check.index}`,item=expected.find(v=>v.field===check.field&&v.index===check.index);
      if(!item||keys.has(key))return false;keys.add(key);
      if([...check.evidenceIds,...check.claims.flatMap(c=>c.evidenceIds)].some(id=>full?!fullReference(context,id):!context.evidence.some(e=>e.id===id)))return false;
      if(!full&&check.claims.some(c=>!item.value.includes(c.text)))return false;
    }
    if(review.checks.length<expected.length)return true;
    if(full){assertFullReview(review,candidate,context);return false;}
    try{requireCompleteReview(raw,candidate.candidates.map(c=>({field:c.field,values:c.items.map(i=>i.value)})));return false;}
    catch{return true;}
  }catch{return false;}
}
