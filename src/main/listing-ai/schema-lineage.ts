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
import { createHash } from 'node:crypto';

const same=(a:unknown,b:unknown):boolean=>JSON.stringify(a)===JSON.stringify(b);
const omit=(value:object,keys:readonly string[])=>Object.fromEntries(Object.entries(value).filter(([key])=>!keys.includes(key)));
const matches=(schema:AmazonSchema,context:ListingAiContext):boolean=>schema.checksum===context.schemaChecksum&&schema.version===context.schemaVersion
  &&listingFingerprint({schema:schema.schema,metaSchema:schema.metaSchema})===context.schemaSha256;
const schemaIdentity=(schema:AmazonSchema)=>omit(schema,['fetchedAt','expiresAt','fromCache']);

/** Historical decoding only. This does not authorize these fields against current facts. */
export function adoptionSchema(draft:AmazonDraft,context:ListingAiContext,adoption:ListingFieldAdoption,db?:DatabaseSync):AmazonSchema|null {
  if(context.productRevision===draft.productRevision){const schema=familyAdoptionSchema(draft,context,adoption,db);if(schema)return schema;}
  if(!db)return null;
  try {
    // A family rebind may sit between source adaptations. Validate its complete
    // transition with the existing strict validator, then continue backwards.
    const families=db.prepare("SELECT detail_json FROM audit_events WHERE action='listing.family.rebound' AND product_id=?").all(draft.productId)
      .map(row=>JSON.parse(String(row.detail_json))).filter(detail=>detail?.draftId===draft.id);
    if(families.length===1){
      const old=families[0].before?.draft as AmazonDraft|undefined;
      if(old?.schema&&old.revision<draft.revision&&old.revision>=adoption.toRevision){
        const probe={...context,productRevision:old.productRevision,schemaChecksum:old.schema.checksum,schemaVersion:old.schema.version,
          schemaSha256:listingFingerprint({schema:old.schema.schema,metaSchema:old.schema.metaSchema}),parentageLevel:old.schema.parentageLevel,
          productType:old.schema.productType,marketplaceId:old.marketplaceId,locale:old.schema.locale,requirements:old.schema.requirements};
        if(familyAdoptionSchema(draft,probe,adoption,db,true))return adoptionSchema(old,context,adoption,db);
      }
    }
    const rows=db.prepare("SELECT summary,detail_json,created_at FROM audit_events WHERE action='listing.task-adapted' AND product_id=?").all(draft.productId)
      .map(row=>({row,detail:JSON.parse(String(row.detail_json))})).filter(({detail})=>detail?.before?.id===draft.id)
      .filter(({detail})=>detail.afterRevision>adoption.toRevision&&detail.afterRevision<=draft.revision)
      .sort((a,b)=>b.detail.afterRevision-a.detail.afterRevision);
    if(new Set(rows.map(({detail})=>detail.afterRevision)).size!==rows.length)return null;
    let cursor=draft;
    for(const {row,detail} of rows){
      if(detail.version!==1||row.summary!=='旧草稿原地适配')return null;
      const before=detail.beforeRecord as DraftRecord,after=detail.afterRecord as DraftRecord;
      const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
      if(!before?.draft||!after?.draft||hash(before)!==detail.beforeSha256||hash(after)!==detail.afterSha256||!same(detail.before,before.draft))return null;
      const old=before.draft,next=after.draft;
      if(before.unresolvedWrite!==false||after.unresolvedWrite!==false||old.submittedAt!==null||next.submittedAt!==null
        ||!['DRAFT','BLOCKED','LOCAL_VALIDATED','AMAZON_VALIDATED'].includes(old.state)||!['BLOCKED','LOCAL_VALIDATED'].includes(next.state)
        ||next.previewedAt!==null||after.preview!==null||next.revision!==old.revision+1||detail.afterRevision!==next.revision
        ||old.revision<adoption.toRevision||next.revision>cursor.revision||!Number.isSafeInteger(old.productRevision)
        ||!Number.isSafeInteger(next.productRevision)||old.productRevision>next.productRevision||next.productRevision!==cursor.productRevision)return null;
      for(const key of ['id','productId','variantId','sku','targetId','sellerId','marketplaceId','mode','listingProgram','createdAt'] as const)
        if(old[key]!==draft[key]||next[key]!==draft[key])return null;
      if(!same(omit(before,['draft','request','preview']),omit(after,['draft','request','preview']))
        ||!same(after.request,{productType:next.schema.productType,requirements:next.schema.requirements,attributes:next.attributes})
        ||!same(omit(old,['revision','productRevision','schema','attributes','businessRules','salesPlan','state','localIssues','previewedAt','updatedAt','events']),
          omit(next,['revision','productRevision','schema','attributes','businessRules','salesPlan','state','localIssues','previewedAt','updatedAt','events'])))return null;
      for(const key of ['targetId','productType','requirements','parentageLevel','locale','mode'] as const)if(old.schema[key]!==next.schema[key])return null;
      if(!same(schemaIdentity(next.schema),schemaIdentity(cursor.schema)))return null;
      // A recipe may be refreshed, but sale/naming/family identity may not.
      if(!same(old.salesPlan&&omit(old.salesPlan,['recipe']),next.salesPlan&&omit(next.salesPlan,['recipe'])))return null;
      if(!Array.isArray(old.fieldAdoptions)||!same(old.fieldAdoptions,next.fieldAdoptions)
        ||!same(next.fieldAdoptions,cursor.fieldAdoptions?.slice(0,old.fieldAdoptions.length))||!old.fieldAdoptions.some(a=>same(a,adoption)))return null;
      for(const [field,value] of Object.entries(old.attributes))if(!same(value,next.attributes[field])
        &&(!old.businessRules?.fields[field]||!same(value,old.businessRules.fields[field].value)))return null;
      if(![old.updatedAt,next.updatedAt,cursor.updatedAt].every(value=>typeof value==='string'&&Number.isFinite(Date.parse(value)))
        ||next.updatedAt!==row.created_at||Date.parse(old.updatedAt)>Date.parse(next.updatedAt)||Date.parse(next.updatedAt)>Date.parse(cursor.updatedAt)
        ||Date.parse(adoption.at)>Date.parse(old.updatedAt))return null;
      const event=next.events.at(-1);
      if(!event||event.operation!=='local_validation'||event.state!==next.state||event.requestId!==next.requestId
        ||event.summary!=='用户适配当前来源与规则；保留原属性、图片和平台响应，本地重新校验'||!Number.isFinite(Date.parse(event.at))
        ||Date.parse(event.at)<Date.parse(next.updatedAt)||!same(next.events,[...old.events,event])||!same(next.events,cursor.events.slice(0,next.events.length)))return null;
      cursor=old;
      const schema=adoptionSchema(cursor,context,adoption,db);if(schema)return schema;
    }
    return null;
  }catch{return null;}
}

/** An obsolete family schema needs the original, narrowly validated rebind. */
function familyAdoptionSchema(draft:AmazonDraft,context:ListingAiContext,adoption:ListingFieldAdoption,db?:DatabaseSync,rebindOnly=false):AmazonSchema|null {
  if(!rebindOnly&&matches(draft.schema,context))return draft.schema;
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
