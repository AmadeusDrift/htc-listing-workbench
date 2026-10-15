import { SOURCE_REFERENCE_PROTOCOL } from '../../shared/source-reference-alias-contracts.ts';
import type { SourceReferenceAliases } from '../../shared/source-reference-alias-contracts.ts';
import type { SourceConsistencyContext } from '../../shared/source-image-consistency-contracts.ts';
import { keys, sha256, uuid } from '../ai/primitives.ts';
import { AiError } from '../ai/errors.ts';
import { listingFingerprint } from '../json-fingerprint.ts';

function dataKeys(raw:unknown,names:string[]):Record<string,unknown>{
  const value=keys(raw,names);
  if(Reflect.ownKeys(value).some(key=>typeof key!=='string')||Object.values(Object.getOwnPropertyDescriptors(value)).some(d=>!('value' in d)||!d.enumerable))throw new AiError('INVALID_INPUT');
  return value;
}

/** The complete original context hash binds variant, scope, image versions and bindings. */
export function validateSourceReferenceAliases(raw: unknown, context: SourceConsistencyContext): SourceReferenceAliases {
  // The owning reader validates the context itself. Require its full shape here,
  // without importing the domain parser back into comparison's wire boundary.
  keys(context, ['version','productId','productRevision','variantId','identity','referenceAssets','fields','claims','issues']);
  const original = context, o = dataKeys(raw, ['version', 'contextSha256', 'entries']);
  if (o.version !== SOURCE_REFERENCE_PROTOCOL || sha256(o.contextSha256) !== listingFingerprint(original)
    || !Array.isArray(o.entries) || o.entries.length !== original.referenceAssets.length) throw new AiError('INVALID_INPUT');
  if(Object.getPrototypeOf(o.entries)!==Array.prototype||Reflect.ownKeys(o.entries).length!==o.entries.length+1)throw new AiError('INVALID_INPUT');
  for(let index=0;index<o.entries.length;index++){
    const descriptor=Object.getOwnPropertyDescriptor(o.entries,String(index));
    if(!descriptor||!('value' in descriptor)||!descriptor.enumerable)throw new AiError('INVALID_INPUT');
  }
  const entries = o.entries.map((raw, index) => {
    const entry = dataKeys(raw, ['alias', 'assetId', 'sha256']), ref = original.referenceAssets[index];
    if (entry.alias !== `ref_${index + 1}` || uuid(entry.assetId) !== ref.assetId || sha256(entry.sha256) !== ref.sha256) throw new AiError('INVALID_INPUT');
    return { alias: entry.alias as string, assetId: ref.assetId, sha256: ref.sha256 };
  });
  return { version: SOURCE_REFERENCE_PROTOCOL, contextSha256: listingFingerprint(original), entries };
}

export function createSourceReferenceAliases(context: SourceConsistencyContext): SourceReferenceAliases {
  return validateSourceReferenceAliases({ version: SOURCE_REFERENCE_PROTOCOL, contextSha256: listingFingerprint(context),
    entries: context.referenceAssets.map((ref, index) => ({ alias: `ref_${index + 1}`, assetId: ref.assetId, sha256: ref.sha256 })) }, context);
}

/** Marker and snapshot are a pair; a new call with a lost map must never fall back to UUID parsing. */
export function sourceReferenceAliasesForCall(call: { sourceReferenceProtocol?: unknown; sourceReferenceAliases?: unknown; sourceConsistencyContext?: SourceConsistencyContext }): SourceReferenceAliases | undefined {
  if (call.sourceReferenceProtocol === undefined && call.sourceReferenceAliases === undefined) return undefined;
  if (call.sourceReferenceProtocol !== SOURCE_REFERENCE_PROTOCOL || !call.sourceConsistencyContext || call.sourceReferenceAliases === undefined) throw new AiError('INVALID_INPUT');
  return validateSourceReferenceAliases(call.sourceReferenceAliases, call.sourceConsistencyContext);
}
