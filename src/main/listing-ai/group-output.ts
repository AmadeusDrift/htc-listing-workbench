import type { ListingFieldsOutput,ListingAiContext } from '../../shared/listing-ai-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { parseFullGeneration,retainValidNativeCandidates } from './full-schema.ts';
import { isFullSchema } from './native-values.ts';
/** Local composition only; each source remains an independently owned paid result. */
export function assembleFieldOutputs(outputs:ListingFieldsOutput[],context?:ListingAiContext):ListingFieldsOutput{
  const first=outputs[0];if(!first||outputs.some(o=>o.contract!==first.contract))throw new UserFacingError('分组字段契约不一致');
  const seen=new Set<string>(),result:ListingFieldsOutput={kind:'amazon-fields',...(first.contract?{contract:first.contract}:{}),candidates:[],missing:[]};
  for(const output of outputs){
    for(const field of [...output.candidates,...output.missing]){if(seen.has(field.field))throw new UserFacingError('分组响应字段重叠，未覆盖已有结果');seen.add(field.field);}
    result.candidates.push(...structuredClone(output.candidates));result.missing.push(...structuredClone(output.missing));
    if(output.rejectedCandidates?.length)(result.rejectedCandidates??=[]).push(...structuredClone(output.rejectedCandidates));
  }
  if(context&&isFullSchema(context)){
    // A dependent sibling may have come from another configured model. Re-evaluate all retained
    // Schema-rejected candidates together. Citation/format/conflict rejection is not a Schema
    // dependency: its rejected projection may already have removed invalid evidence IDs.
    const schemaOnly=new Set(result.missing.filter(m=>/^\[LOCAL_[a-zA-Z_]+\]/.test(m.reason)&&result.missing.filter(other=>other.field===m.field).every(other=>/^\[LOCAL_[a-zA-Z_]+\]/.test(other.reason))).map(m=>m.field));
    const eligible=(result.rejectedCandidates??[]).filter(c=>schemaOnly.has(c.field));
    return retainValidNativeCandidates(parseFullGeneration({...result,candidates:[...result.candidates,...eligible]},context),context);
  }
  return result;
}
