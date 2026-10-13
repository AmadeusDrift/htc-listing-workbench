import type { ListingFieldsOutput } from '../../shared/listing-ai-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
/** Local composition only; each source remains an independently owned paid result. */
export function assembleFieldOutputs(outputs:ListingFieldsOutput[]):ListingFieldsOutput{
  const first=outputs[0];if(!first||outputs.some(o=>o.contract!==first.contract))throw new UserFacingError('分组字段契约不一致');
  const seen=new Set<string>(),result:ListingFieldsOutput={kind:'amazon-fields',...(first.contract?{contract:first.contract}:{}),candidates:[],missing:[]};
  for(const output of outputs){
    for(const field of [...output.candidates,...output.missing]){if(seen.has(field.field))throw new UserFacingError('分组响应字段重叠，未覆盖已有结果');seen.add(field.field);}
    result.candidates.push(...structuredClone(output.candidates));result.missing.push(...structuredClone(output.missing));
    if(output.rejectedCandidates?.length)(result.rejectedCandidates??=[]).push(...structuredClone(output.rejectedCandidates));
  }
  return result;
}
