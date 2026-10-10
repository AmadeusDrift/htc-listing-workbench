import type { DatabaseSync } from 'node:sqlite';
import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import { readListingRules } from '../listing-rules.ts';
import { assertCurrentPricingForPaid } from '../automatic-listing/outcomes.ts';

/** Synchronous final send guard. Never writes drafts or changes completed/unknown journals. */
export function assertStoredPricingForPaid(db:DatabaseSync,draftId:string):void {
  const row=db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(draftId);
  // Legacy provider-only contexts did not have a listing draft. Their existing freshness guard applies.
  if(!row?.record_json)return;
  const draft=(JSON.parse(String(row.record_json)) as {draft:AmazonDraft}).draft;
  assertCurrentPricingForPaid(draft,readListingRules(db));
}
