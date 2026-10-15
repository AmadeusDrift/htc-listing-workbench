import {createHash} from 'node:crypto';
import type {CategoryPhaseContext} from '../../shared/category-ai-contracts.ts';
import type {ProductTypeOption} from '../../shared/amazon-contracts.ts';
import {listingFingerprint} from '../json-fingerprint.ts';
import {boundedText,keys,sha256,uuid,invalid} from './primitives.ts';

/** One root product classification identity; changing configuration/input/task does not open a new budget. */
export function categoryOperationId(productId:string):string {
 const hash=createHash('sha256').update('htc-category-operation/v1:'+uuid(productId)).digest('hex');
 return `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
/** Candidate order, codes and real display names all belong to the exact request snapshot. */
export function categoryCandidateSnapshot(candidates:readonly ProductTypeOption[]):string {
 if(!Array.isArray(candidates)||candidates.length>50)invalid('INVALID_INPUT');
 const snapshot=candidates.map(candidate=>({name:boundedText(candidate.name,100),displayName:boundedText(candidate.displayName,1000)}));
 if(snapshot.some(candidate=>!/^[A-Z0-9_]+$/.test(candidate.name))||new Set(snapshot.map(candidate=>candidate.name)).size!==snapshot.length)invalid('INVALID_INPUT');
 return listingFingerprint(snapshot);
}
export function validateCategoryPhaseContext(raw:unknown,productId?:string):CategoryPhaseContext {
 try {
  if(!raw||typeof raw!=='object'||Reflect.ownKeys(raw).some(key=>typeof key!=='string')||Object.values(Object.getOwnPropertyDescriptors(raw)).some(descriptor=>!('value' in descriptor)))invalid('INVALID_INPUT');
  const version=(raw as {version?:unknown}).version;
  const c=keys(raw,version===1?['version','phase','requestSha256']:['version','phase','requestSha256','operationId','inputVersion','candidateSnapshotSha256','expansion']);
  if(version!==1&&version!==2||typeof c.phase!=='string'||!['keywords','select','judge'].includes(c.phase))invalid('INVALID_INPUT');
  const phase=c.phase as CategoryPhaseContext['phase'],requestSha256=sha256(c.requestSha256);
  if(version===1)return {version:1,phase,requestSha256};
  if(!productId||c.operationId!==categoryOperationId(productId)||![0,1].includes(Number(c.expansion))||typeof c.expansion!=='number'||phase==='keywords'&&c.expansion!==0)invalid('INVALID_INPUT');
  return {version:2,phase,requestSha256,operationId:uuid(c.operationId),inputVersion:sha256(c.inputVersion),candidateSnapshotSha256:sha256(c.candidateSnapshotSha256),expansion:c.expansion as 0|1};
 }catch{invalid('INVALID_INPUT');}
}
