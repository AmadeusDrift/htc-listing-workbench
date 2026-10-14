import type {ListingCorrection} from '../../shared/listing-correction-contracts.ts';
import {UserFacingError} from '../../shared/errors.ts';
import {createHash} from 'node:crypto';
import {semanticJson} from './preparation.ts';
const keys=new Set('id revision patchHash draftId draftRevision draftStamp listingHash previousId targetId sellerId marketplaceId sku productType locale generation targetStamp typeEvidence submittedAttributesHash remoteLocalIssues state request before after baselineHash schemaHash createdAt updatedAt readyAt message preview response readback remainingIssues correctionVersion scope evidence problemKey round'.split(' '));
export function validateCorrectionRecord(value:ListingCorrection):ListingCorrection {
 const fail=():never=>{throw new UserFacingError('修正记录版本、范围或依据无效；保留历史，禁止发送');};
 if(!value||typeof value!=='object'||Object.keys(value).some(key=>!keys.has(key)))fail();
 const hasMetadata=['correctionVersion','scope','evidence','problemKey','round'].some(key=>Object.hasOwn(value,key));
 if(!hasMetadata){const patches=value.request?.patches;if(!Array.isArray(patches)||patches.length!==1||!patches[0]||typeof patches[0]!=='object'||Array.isArray(patches[0])||patches[0].op!=='delete'||patches[0].path!=='/attributes/package_contains_sku')fail();return value;} // Legacy supports only the original self-reference deletion.
 if(value.correctionVersion!==2||!Array.isArray(value.scope)||!value.scope.length||value.scope.length>100||value.scope.some(field=>typeof field!=='string'||!(/^[a-z][a-z0-9_]*$/).test(field))||new Set(value.scope).size!==value.scope.length||!Array.isArray(value.evidence)||value.evidence.length!==value.scope.length||value.evidence.some(e=>typeof e!=='string'||!e.trim()||e.length>2000)||![1,2].includes(value.round??0))fail();
 const scope=value.scope!,patches=value.request?.patches;
 if(!Array.isArray(patches)||patches.length!==scope.length||patches.some((p,i)=>!p||typeof p!=='object'||Array.isArray(p)||p.path!==`/attributes/${scope[i]}`||!['replace','delete'].includes(String(p.op))))fail();
 if(value.problemKey!==createHash('sha256').update(semanticJson([...scope].sort())).digest('hex'))fail();
 return value;
}
