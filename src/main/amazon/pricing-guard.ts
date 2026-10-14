import type { DatabaseSync } from 'node:sqlite';
import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import { readListingRules } from '../listing-rules.ts';
import { assertCurrentPricingForPaid } from '../pricing/qualification.ts';
import { sourceQuantity } from '../../shared/source-quantity.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { readProductFactModel } from '../products/public.ts';

/** Only the source revision adopted by this draft is applicable; newly received supplier prose is not. */
export function storedSalesUnitIssue(db:DatabaseSync,draft:AmazonDraft):string|null {
  if(draft.salesPlan?.recipe.quantityVersion===2||draft.listingProgram!=='haul'||draft.schema.parentageLevel==='PARENT')return null;
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='products'").get())return null;
  const product=db.prepare('SELECT title,description,revision FROM products WHERE id=?').get(draft.productId);
  if(!product||product.revision!==draft.productRevision)return null;
  const scoped=readProductFactModel(db,draft.productId)===1;
  const variants=draft.salesPlan?.recipe.components.map(c=>c.variantId)??[draft.variantId];
  for(const id of variants){
    const v=db.prepare('SELECT original_spec,normalized_spec FROM variants WHERE id=? AND product_id=?').get(id,draft.productId);
    if(!v)continue;
    if(sourceQuantity(String(v.normalized_spec||v.original_spec),scoped?'':String(product.title),[String(v.original_spec),scoped?'':String(product.description)].join('\n')).unitSemantics)
      return '历史套装报价与附件计量尚未分别确认；请查看计量对照并明确采用，原历史/SKU保持不变';
  }
  return null;
}

/** Synchronous final send guard. Never writes drafts or changes completed/unknown journals. */
export function assertStoredPricingForPaid(db:DatabaseSync,draftId:string):void {
  const row=db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(draftId);
  // Legacy provider-only contexts did not have a listing draft. Their existing freshness guard applies.
  if(!row?.record_json)return;
  const draft=(JSON.parse(String(row.record_json)) as {draft:AmazonDraft}).draft;
  const units=storedSalesUnitIssue(db,draft);if(units)throw new UserFacingError(units);
  assertCurrentPricingForPaid(draft,readListingRules(db));
}
