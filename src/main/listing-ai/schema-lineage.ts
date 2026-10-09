import type { DatabaseSync } from 'node:sqlite';
import type { AmazonDraft, AmazonSchema } from '../../shared/amazon-contracts.ts';
import type { ListingAiContext, ListingFieldAdoption } from '../../shared/listing-ai-contracts.ts';
import type { DraftRecord } from '../amazon/persistence.ts';
import { isObject } from '../amazon/context.ts';
import { FAMILY_REBIND_EVENT_SUMMARY } from '../amazon/service.ts';
import { relationshipAttributes } from '../sales-plans/families.ts';
import { assertSalesPlanNamingIdentity } from '../sales-plans/history.ts';
import { validateSalesPlan } from '../sales-plans/records.ts';
import { listingFingerprint } from './validation.ts';

const same=(a:unknown,b:unknown):boolean=>JSON.stringify(a)===JSON.stringify(b);
const omit=(value:object,keys:readonly string[])=>Object.fromEntries(Object.entries(value).filter(([key])=>!keys.includes(key)));
const matches=(schema:AmazonSchema,context:ListingAiContext):boolean=>schema.checksum===context.schemaChecksum&&schema.version===context.schemaVersion
  &&listingFingerprint({schema:schema.schema,metaSchema:schema.metaSchema})===context.schemaSha256;
const schemaIdentity=(schema:AmazonSchema)=>omit(schema,['fetchedAt','expiresAt','fromCache']);

/** An obsolete schema is usable only through the recorded one-step family rebind. */
export function adoptionSchema(draft:AmazonDraft,context:ListingAiContext,adoption:ListingFieldAdoption,db?:DatabaseSync):AmazonSchema|null {
  if(matches(draft.schema,context))return draft.schema;
  if(!db)return null;
  try {
    const events=db.prepare("SELECT product_id,summary,detail_json,created_at FROM audit_events WHERE action='listing.family.rebound' AND product_id=?").all(draft.productId)
      .map(row=>({row,detail:JSON.parse(String(row.detail_json))})).filter(({detail})=>detail?.draftId===draft.id);
    // NONE -> CHILD can occur only once for one immutable sale identity.
    if(events.length!==1)return null;
    const {row,detail}=events[0];
    if(!isObject(detail)||!same(Object.keys(detail).sort(),['after','before','draftId'])||row.summary!==FAMILY_REBIND_EVENT_SUMMARY)return null;
    const before=detail.before as unknown as DraftRecord,after=detail.after as unknown as DraftRecord;
    if(!isObject(before)||!isObject(after)||!isObject(before.draft)||!isObject(after.draft))return null;
    const old=before.draft,next=after.draft;
    if(before.unresolvedWrite!==false||after.unresolvedWrite!==false||old.submittedAt!==null||next.submittedAt!==null
      ||!['DRAFT','BLOCKED','LOCAL_VALIDATED','AMAZON_VALIDATED'].includes(old.state)||next.state!=='DRAFT'
      ||next.previewedAt!==null||next.requestId!==null||after.preview!==null||after.previewResponse!==null)return null;
    if(!same(omit(before,['draft','request','preview','previewResponse']),omit(after,['draft','request','preview','previewResponse']))
      ||!same(after.request,{productType:next.schema.productType,requirements:next.schema.requirements,attributes:next.attributes}))return null;
    if(!Number.isSafeInteger(old.revision)||old.revision<adoption.toRevision||next.revision!==old.revision+1||draft.revision<next.revision
      ||![old.updatedAt,next.updatedAt,draft.updatedAt].every(value=>typeof value==='string'&&Number.isFinite(Date.parse(value)))||next.updatedAt!==row.created_at
      ||Date.parse(old.updatedAt)>Date.parse(next.updatedAt)||Date.parse(next.updatedAt)>Date.parse(draft.updatedAt)||Date.parse(adoption.at)>Date.parse(old.updatedAt))return null;
    for(const key of ['id','productId','productRevision','variantId','sku','targetId','sellerId','marketplaceId','mode','listingProgram','createdAt'] as const)
      if(old[key]!==draft[key]||next[key]!==draft[key])return null;
    if(!same(omit(old,['revision','schema','attributes','state','localIssues','previewIssues','previewedAt','requestId','updatedAt','events','salesPlan']),
      omit(next,['revision','schema','attributes','state','localIssues','previewIssues','previewedAt','requestId','updatedAt','events','salesPlan'])))return null;
    const priorPlan=validateSalesPlan(old.salesPlan),nextPlan=validateSalesPlan(next.salesPlan);
    if(priorPlan.parentage!=='NONE'||!priorPlan.familyResolved||old.schema.parentageLevel!=='NONE'||nextPlan.parentage!=='CHILD'
      ||!nextPlan.familyResolved||next.schema.parentageLevel!=='CHILD'||!same(nextPlan,draft.salesPlan))return null;
    for(const key of ['namingGroupId','sourceGroupKey','collectedAt','collectionBasis','sku','baseSku','namingChildKey','recipe'] as const)
      if(!same(priorPlan[key],nextPlan[key]))return null;
    assertSalesPlanNamingIdentity(db,priorPlan,draft.mode,draft.sellerId);assertSalesPlanNamingIdentity(db,nextPlan,draft.mode,draft.sellerId);
    for(const key of ['targetId','productType','requirements','locale','mode'] as const)if(old.schema[key]!==next.schema[key]||next.schema[key]!==draft.schema[key])return null;
    if(!matches(old.schema,context)||!same(schemaIdentity(next.schema),schemaIdentity(draft.schema))
      ||context.parentageLevel!==old.schema.parentageLevel||context.productType!==old.schema.productType||context.marketplaceId!==old.marketplaceId
      ||context.locale!==old.schema.locale||context.requirements!==old.schema.requirements)return null;
    const adoptions=old.fieldAdoptions;
    if(!Array.isArray(adoptions)||!same(adoptions,next.fieldAdoptions)||!same(adoptions,draft.fieldAdoptions?.slice(0,adoptions.length))
      ||!adoptions.some(record=>same(record,adoption)))return null;
    const event={at:next.updatedAt,operation:'save',state:'DRAFT',requestId:null,summary:FAMILY_REBIND_EVENT_SUMMARY};
    if(!Array.isArray(old.events)||!same(next.events,[...old.events,event])||!same(next.events,draft.events.slice(0,next.events.length)))return null;
    const axes=nextPlan.variationTheme!.split('/'),mutable=['parentage_level','variation_theme','child_parent_sku_relationship',
      ...(axes.some(axis=>['COLOR','COLOR_NAME'].includes(axis))?['color']:[]),...(axes.includes('NUMBER_OF_ITEMS')?['number_of_items']:[])];
    if(new Set(axes).size!==axes.length||axes.some(axis=>!['COLOR','COLOR_NAME','NUMBER_OF_ITEMS'].includes(axis))
      ||!same(omit(old.attributes,mutable),omit(next.attributes,mutable)))return null;
    const relationships=relationshipAttributes(next.schema,nextPlan,next.marketplaceId);
    for(const [field,value] of Object.entries(relationships))if(!same(next.attributes[field],value))return null;
    return old.schema;
  } catch {return null;}
}
