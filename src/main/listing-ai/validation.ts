/** Current contract entrypoint. Preserve versioned implementations when advancing policy. */
export * from './evidence-validation-v3.ts';
import * as legacy from './evidence-validation-v3.ts';
import { isFullSchema,parseFullOutput,validateFullContext,assertFullEvidence,parseFullReview,assertFullReview } from './full-schema.ts';
export const validateListingContext=(raw:unknown)=>isFullSchema(raw as never)?validateFullContext(raw):legacy.validateListingContext(raw);
export const validateListingFieldsOutput=(raw:unknown)=>isFullSchema(raw as never)?parseFullOutput(raw):legacy.validateListingFieldsOutput(raw);
export const validateListingReviewOutput=(raw:unknown)=>isFullSchema(raw as never)?parseFullReview(raw):legacy.validateListingReviewOutput(raw);
export function assertListingEvidence(...args:Parameters<typeof legacy.assertListingEvidence>):void {if(isFullSchema(args[1] as never))assertFullEvidence(args[0],args[1]);else legacy.assertListingEvidence(...args);}
export function assertListingReview(...args:Parameters<typeof legacy.assertListingReview>):void {if(isFullSchema(args[2] as never))assertFullReview(args[0],args[1],args[2]);else legacy.assertListingReview(...args);}
