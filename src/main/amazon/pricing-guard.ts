import type { DatabaseSync } from 'node:sqlite';
import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import { readListingRules } from '../listing-rules.ts';
import { assertCurrentPricingForPaid } from '../pricing/qualification.ts';
import { sourceQuantity } from '../../shared/source-quantity.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { readProductFactModel } from '../products/public.ts';
import { productSourceQuantity } from '../../shared/source-quantity.ts';
import type { ProductDetail } from '../../shared/contracts.ts';

/** A product-owner before snapshot is exact revision evidence; an arbitrary newer title is not. */
function originalUnitIssue(db:DatabaseSync,draft:AmazonDraft):string|null {
  const components=draft.salesPlan?.recipe.components??[];
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_events'").get()){
    const rows=db.prepare("SELECT json_extract(detail_json,'$.before') snapshot FROM audit_events WHERE product_id=? AND action='product.updated' AND length(detail_json)<=16777216 AND json_extract(detail_json,'$.before.id')=? AND json_extract(detail_json,'$.before.revision')=? AND json_extract(detail_json,'$.after.id')=? AND json_extract(detail_json,'$.after.revision')=? LIMIT 2")
      .all(draft.productId,draft.productId,draft.productRevision,draft.productId,draft.productRevision);
    if(rows.length===1){
      const source=JSON.parse(String(rows[0].snapshot)) as ProductDetail;
      if(typeof source.title==='string'&&typeof source.description==='string'&&Array.isArray(source.variants)&&Array.isArray(source.facts)){
        const ids=components.length?components.map(c=>c.variantId):[draft.variantId];
        let complete=true;
        for(const id of ids){
          const variant=source.variants.find(v=>v.id===id),component=components.find(c=>c.variantId===id);
          if(!variant||typeof variant.originalSpec!=='string'||typeof variant.normalizedSpec!=='string'||component&&variant.sku!==component.sourceSku){complete=false;break;}
          // Normalization may already contain the erroneous accessory count. Only
          // original owner evidence can establish the adopted quote's unit basis.
          const quantity=productSourceQuantity(source,{...variant,normalizedSpec:''});
          if(quantity.unitSemantics)return '原采用修订中的套装计量仍需明确确认；无关资料修订不解除历史错误报价';
          if(quantity.conflict||component&&(quantity.piecesPerQuote!==component.piecesPerQuote||quantity.piecesPerPack!==component.sourcePackPieces))return '原采用修订的件数或报价单位与历史配方不一致，请核对原计量依据';
        }
        if(complete)return null;
      }
    }
  }
  // Legacy component wording is derived, not proof of the original supplier unit.
  return '原采用修订的计量依据未能可靠定位，请核对原销售单位；不能因无关修订变化继续判定旧报价合格';
}

/** Only the source revision adopted by this draft is applicable; newly received supplier prose is not. */
export function storedSalesUnitIssue(db:DatabaseSync,draft:AmazonDraft):string|null {
  if(draft.salesPlan?.recipe.quantityVersion===2||draft.listingProgram!=='haul'||draft.schema.parentageLevel==='PARENT')return null;
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='products'").get())return null;
  const product=db.prepare('SELECT title,description,revision FROM products WHERE id=?').get(draft.productId);
  if(!product||product.revision!==draft.productRevision)return originalUnitIssue(db,draft);
  const scoped=readProductFactModel(db,draft.productId)===1;
  const variants=draft.salesPlan?.recipe.components.map(c=>c.variantId)??[draft.variantId];
  for(const id of variants){
    const v=db.prepare('SELECT original_spec,normalized_spec FROM variants WHERE id=? AND product_id=?').get(id,draft.productId);
    if(!v)continue;
    if(sourceQuantity(String(v.normalized_spec||v.original_spec),scoped?'':String(product.title),[String(v.original_spec),scoped?'':String(product.description)].join('\n'),String(v.original_spec)).unitSemantics)
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
