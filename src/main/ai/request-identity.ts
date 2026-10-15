import type { AiCall, AiProfile } from '../../shared/ai-contracts.ts';
import { AI_REQUEST_OPERATIONS } from '../../shared/ai-request-identity-contracts.ts';
import type { AiRequestScope } from '../../shared/ai-request-identity-contracts.ts';
import { keys, uuid, uuidList, sha256, integer, invalid, CAPABILITIES } from './primitives.ts';
import { evidenceSku } from '../diagnostics/run-evidence.ts';

export function validateRequestScope(raw:unknown):AiRequestScope {
  if(!raw||typeof raw!=='object'||Object.getPrototypeOf(raw)!==Object.prototype||Reflect.ownKeys(raw).some(key=>typeof key!=='string')||Object.values(Object.getOwnPropertyDescriptors(raw)).some(value=>!('value' in value)))invalid();
  const o=keys(raw,['version','productId','operation'],['variantId','variantIds','assetId','sku','draftId','targetId','marketplaceId','slot','candidateSha256','phase']);
  if(o.version!==1||!AI_REQUEST_OPERATIONS.includes(o.operation as AiRequestScope['operation']))invalid();
  const scope:AiRequestScope={version:1,productId:uuid(o.productId),operation:o.operation as AiRequestScope['operation']};
  for(const field of ['variantId','assetId','draftId'] as const)if(o[field]!==undefined)scope[field]=uuid(o[field]);
  if(o.variantIds!==undefined){scope.variantIds=uuidList(o.variantIds,100,1);if(JSON.stringify(scope.variantIds)!==JSON.stringify([...scope.variantIds].sort()))invalid();}
  if(o.targetId!==undefined){if(typeof o.targetId!=='string'||!/^[A-Za-z0-9_.:-]{1,100}$/.test(o.targetId))invalid();scope.targetId=o.targetId;}
  if(o.sku!==undefined){if(!evidenceSku(o.sku))invalid();scope.sku=o.sku;}
  if(o.marketplaceId!==undefined){if(typeof o.marketplaceId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(o.marketplaceId))invalid();scope.marketplaceId=o.marketplaceId;}
  if(o.slot!==undefined)scope.slot=integer(o.slot,0,7);
  if(o.candidateSha256!==undefined)scope.candidateSha256=sha256(o.candidateSha256);
  if(o.phase!==undefined){if(!['keywords','select','judge'].includes(String(o.phase)))invalid();scope.phase=o.phase as AiRequestScope['phase'];}
  return scope;
}
function operation(profile:Pick<AiProfile,'id'|'capability'|'routing'>,source:any):AiRequestScope['operation'] {
  const op=source?.operation;
  if(op==='amazon-fields')return 'listing-fields';
  if(op==='amazon-fields-review'||op==='listing-current-review')return 'listing-copy-review';
  if(op==='category-decision')return 'category';
  if(op==='source-image-consistency')return 'source-observation';
  if(op==='source-color')return 'source-color';
  if(AI_REQUEST_OPERATIONS.includes(op))return op;
  if(profile.capability==='ocr')return 'source-ocr';
  if(profile.capability==='segmentation')return 'source-segmentation';
  return profile.capability==='text-review'?'content-review':'content-suggestion';
}
/** Sources here are already validated main snapshots, not renderer-selected identity. */
export function requestScope(profile:AiProfile,input:{productId:string},source:unknown):AiRequestScope {
  const s=source as any,c=s?.context?.listing??s?.context,variantId=(input as any).variantId??c?.variantId??s?.payload?.variant?.id??s?.suggestion?.variantId;
  const variants=c?.sourceProduct?.salesRecipe?.recipe?.components?.map((component:any)=>component.variantId);
  return validateRequestScope({version:1,productId:input.productId,operation:operation(profile,s),
    ...(variantId?{variantId}:{}),...(s?.asset?.id?{assetId:s.asset.id}:{}),
    ...(variants?.length?{variantIds:[...new Set<string>(variants)].sort()}:{}),
    ...(c?.sku?{sku:c.sku}:{}),...(c?.targetId?{targetId:c.targetId}:{}),...(c?.marketplaceId?{marketplaceId:c.marketplaceId}:{}),
    ...(s?.context?.slot?{slot:s.context.slot.index}:{}),...(s?.candidate?.sha256?{candidateSha256:s.candidate.sha256}:{}),
    ...(s?.payload?.phase?{phase:s.payload.phase}:{}),
  });
}
/** Missing legacy identity is a wildcard within its known business scope. */
export function legacyRequestScope(call:AiCall):AiRequestScope {
  if(call.requestScope)return call.requestScope;
  const p=call.presentationContext,purpose=call.purposeSnapshot?.purposeId;
  let op:AiRequestScope['operation'];
  if(call.categoryContext||purpose==='category_analysis'||purpose==='category_decision')op='category';
  else if(call.sourceConsistencyContext)op='source-observation';
  else if(call.sourceColorContext)op='source-color';
  else if(p?.kind==='image')op=call.providerId==='aliyun-ocr'?'generated-image-ocr':call.providerId==='aliyun-image-risk'?'image-ip-review':purpose==='image_text_review'?'image-text-review':purpose?.startsWith('appearance_review')?'image-appearance-review':'image-plan';
  else if(p?.kind==='listing')op=CAPABILITIES[call.providerId]==='text-review'?'listing-copy-review':'listing-fields';
  else if(!purpose&&['text','text-review'].includes(CAPABILITIES[call.providerId]))op=CAPABILITIES[call.providerId]==='text-review'?'legacy-text-review-request':'legacy-text-request';
  else op=operation({id:call.providerId,capability:CAPABILITIES[call.providerId]},null);
  return validateRequestScope({version:1,productId:call.productId,operation:op,
    ...(call.sourceConsistencyContext?{variantId:call.sourceConsistencyContext.variantId}:{}),
    ...(call.sourceColorContext?{variantId:call.sourceColorContext.variantId}:{}),
    ...(p?{variantId:p.variantId,...(p.kind==='image'?{slot:p.slot}:{})}:{}),
    ...(call.categoryContext?{phase:call.categoryContext.phase}:{}),
  });
}
export function sameRequestBusiness(a:AiRequestScope,b:AiRequestScope):boolean {
  const generation=['content-suggestion','listing-fields','category','source-observation','source-color','image-plan','legacy-text-request'],review=['content-review','listing-copy-review','image-text-review','image-appearance-review','legacy-text-review-request'];
  const legacy=(scope:AiRequestScope,other:AiRequestScope)=>scope.operation==='legacy-text-request'&&generation.includes(other.operation)||scope.operation==='legacy-text-review-request'&&review.includes(other.operation);
  if(a.productId!==b.productId||a.operation!==b.operation&&!legacy(a,b)&&!legacy(b,a))return false;
  // Compare primary sales IDs with primary sales IDs. Supplier component IDs
  // are a separate namespace and must not erase a matching legacy primary ID.
  if(a.variantId!==undefined&&b.variantId!==undefined){if(a.variantId!==b.variantId)return false;}
  else if(a.variantIds!==undefined&&b.variantIds!==undefined&&!a.variantIds.some(id=>b.variantIds!.includes(id)))return false;
  // Candidate bytes are retained for exact recovery, not a way to bypass an
  // unresolved review at the same original SKU/slot by making another picture.
  return (['assetId','targetId','marketplaceId','slot','phase'] as const).every(field=>a[field]===undefined||b[field]===undefined||a[field]===b[field]);
}
