/** Explicit history-only dispatch. Current authorization never selects rules from persisted metadata. */
import * as legacy from './evidence-validation-v0.ts';
import * as v1 from './evidence-validation-v1.ts';
import * as v2 from './evidence-validation-v2.ts';
import * as v3 from './evidence-validation-v3.ts';
import { AiError } from '../ai/errors.ts';
type Context=Parameters<typeof v1.assertListingEvidence>[1];
export function assertStoredListingEvidence(output:Parameters<typeof v1.assertListingEvidence>[0],context:Context,version?:string):void{
  if(version===undefined){if(context.evidenceBlockers)throw new AiError('OUTPUT_INVALID');legacy.assertListingEvidence(output,context,{historical:true});}
  else if(version==='listing-evidence/v1')v1.assertListingEvidence(output,context);
  else if(version==='listing-evidence/v2')v2.assertListingEvidence(output,context);
  else if(version==='listing-evidence/v3')v3.assertListingEvidence(output,context);
  else throw new AiError('OUTPUT_INVALID');
}
export function assertStoredListingReview(review:Parameters<typeof v1.assertListingReview>[0],candidate:Parameters<typeof v1.assertListingReview>[1],context:Context,version?:string):void{
  if(version===undefined){if(context.evidenceBlockers)throw new AiError('OUTPUT_INVALID');legacy.assertListingReview(review,candidate,context,{historical:true});}
  else if(version==='listing-evidence/v1')v1.assertListingReview(review,candidate,context);
  else if(version==='listing-evidence/v2')v2.assertListingReview(review,candidate,context);
  else if(version==='listing-evidence/v3')v3.assertListingReview(review,candidate,context);
  else throw new AiError('OUTPUT_INVALID');
}

/** Image captions historically used the full v0 rules, not legacy listing-category exemptions. */
export function assertStoredImageEvidence(output:Parameters<typeof v1.assertListingEvidence>[0],context:Context,version?:string):void{
  if(version===undefined){if(context.evidenceBlockers)throw new AiError('OUTPUT_INVALID');legacy.assertListingEvidence(output,context);}
  else if(version==='listing-evidence/v1')v1.assertListingEvidence(output,context);
  else if(version==='listing-evidence/v2')v2.assertListingEvidence(output,context);
  else if(version==='listing-evidence/v3')v3.assertListingEvidence(output,context);
  else throw new AiError('OUTPUT_INVALID');
}
