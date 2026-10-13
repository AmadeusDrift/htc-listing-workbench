import { SOURCE_CONSISTENCY_VERSION,SOURCE_OBSERVATION_VERSION } from '../../shared/source-image-consistency-contracts.ts';
import type { SourceConsistencyContext,SourceConsistencyIdentity } from '../../shared/source-image-consistency-contracts.ts';
import { keys,uuid,sha256,boundedText,integer } from '../ai/primitives.ts';
import { listingFingerprint } from '../json-fingerprint.ts';
import { AiError } from '../ai/errors.ts';
import { projectSourceClaims } from './comparison.ts';
export function validateConsistencyContext(raw:unknown):SourceConsistencyContext {
  const o=keys(raw,['version','productId','productRevision','variantId','identity','referenceAssets','fields','claims','issues']);
  if(![SOURCE_CONSISTENCY_VERSION,SOURCE_OBSERVATION_VERSION].includes(o.version as never)||!Array.isArray(o.fields)||o.fields.length>205||!Array.isArray(o.referenceAssets)||!o.referenceAssets.length||o.referenceAssets.length>10)throw new AiError('INVALID_INPUT');
  const identityRaw=o.identity as Record<string,unknown>;
  const s=keys(identityRaw,identityRaw?.kind==='local-original'?['kind']:['kind','receiptId','receiptFingerprint','sourceSku']);
  let identity:SourceConsistencyIdentity;
  if(s.kind==='local-original')identity={kind:'local-original'};
  else if(s.kind==='native1688'||s.kind==='miaoshou')identity={kind:s.kind,receiptId:uuid(s.receiptId),receiptFingerprint:sha256(s.receiptFingerprint),sourceSku:boundedText(s.sourceSku,256)};
  else throw new AiError('INVALID_INPUT');
  const fields=o.fields.map(raw=>{const f=keys(raw,['id','name','value']);return{id:boundedText(f.id,150),name:boundedText(f.name,200,true),value:boundedText(f.value,4000,true)};});
  if(new Set(fields.map(f=>f.id)).size!==fields.length)throw new AiError('INVALID_INPUT');
  const projection=projectSourceClaims(fields);
  if(listingFingerprint(o.claims)!==listingFingerprint(projection.claims)||listingFingerprint(o.issues)!==listingFingerprint(projection.issues))throw new AiError('INVALID_INPUT');
  const referenceAssets=o.referenceAssets.map(raw=>{const a=keys(raw,['source','assetId','sha256','byteSize','bindingEpoch','anchorId','imageId'],['scope']);if(a.scope!==undefined&&a.scope!=='product')throw new AiError('INVALID_INPUT');if(!['local-original','receipt-image'].includes(String(a.source))||(a.source==='local-original')!==(a.anchorId===null&&a.imageId===null)||a.source==='receipt-image'&&identity.kind==='local-original')throw new AiError('INVALID_INPUT');return{...(a.scope==='product'?{scope:'product' as const}:{}),source:a.source as 'local-original'|'receipt-image',assetId:uuid(a.assetId),sha256:sha256(a.sha256),byteSize:integer(a.byteSize,1,20*1024*1024),bindingEpoch:sha256(a.bindingEpoch),anchorId:a.anchorId===null?null:uuid(a.anchorId),imageId:a.imageId===null?null:boundedText(a.imageId,100)};});
  if(new Set(referenceAssets.map(a=>a.assetId)).size!==referenceAssets.length)throw new AiError('INVALID_INPUT');
  return{version:o.version as SourceConsistencyContext['version'],productId:uuid(o.productId),productRevision:integer(o.productRevision,1,Number.MAX_SAFE_INTEGER),variantId:uuid(o.variantId),identity,referenceAssets,...projection};
}
/** Send liability is image/spec based, independent of model, cosmetic revisions and new anchor timestamps. */
export function consistencyScopeKey(context:SourceConsistencyContext):string {
  return listingFingerprint({productId:context.productId,variantId:context.variantId,identity:context.identity,fields:context.fields,images:context.referenceAssets.map(a=>({sha256:a.sha256,byteSize:a.byteSize,imageId:a.imageId,...(a.scope?{scope:a.scope}:{})})).sort((a,b)=>a.sha256.localeCompare(b.sha256)||a.byteSize-b.byteSize||(a.imageId??'').localeCompare(b.imageId??''))});
}
/** Human authority also pins the live association epoch; broad revision is a command guard only. */
export function consistencyDecisionKey(context:SourceConsistencyContext):string {
  return listingFingerprint({scope:consistencyScopeKey(context),bindings:context.referenceAssets.map(({assetId,bindingEpoch})=>({assetId,bindingEpoch}))});
}
