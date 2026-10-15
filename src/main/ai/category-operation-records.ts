import type {CategoryOperationRecord,CategoryExpansionOperation,CategoryExpansionSnapshot,CategoryExpansionCaptureProof} from '../../shared/category-operation-contracts.ts';
import type {CategoryRepairClaim} from '../../shared/category-ai-contracts.ts';
import {categoryOperationId,categoryCandidateSnapshot} from './category-context.ts';
import {listingFingerprint} from '../json-fingerprint.ts';
import {uuid,sha256,date,boundedText} from './primitives.ts';
import {AiError} from './errors.ts';

function invalid():never {throw new AiError('INVALID_CONFIG');}
function record(raw:unknown,names:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{
 if(!raw||typeof raw!=='object'||Object.getPrototypeOf(raw)!==Object.prototype||Reflect.ownKeys(raw).some(key=>typeof key!=='string')||Object.values(Object.getOwnPropertyDescriptors(raw)).some(value=>!('value' in value)))invalid();
 const value=raw as Record<string,unknown>;if(Reflect.ownKeys(value).some(key=>!names.includes(String(key))&&!optional.includes(String(key)))||names.some(name=>!Object.hasOwn(value,name)))invalid();return value;
}
function list(raw:unknown,max:number,min=0):unknown[]{
 if(!Array.isArray(raw)||Object.getPrototypeOf(raw)!==Array.prototype||raw.length<min||raw.length>max||Reflect.ownKeys(raw).length!==raw.length+1)invalid();
 for(let index=0;index<raw.length;index++){const descriptor=Object.getOwnPropertyDescriptor(raw,String(index));if(!descriptor||!('value' in descriptor))invalid();}return raw;
}
function repair(raw:unknown,id:string):CategoryRepairClaim {
 const r=record(raw,['version','operationId','phase','originalCallIds','retryCallId','inputVersion','candidateSnapshotSha256','continuedAt']);
 if(r.version!==1||r.operationId!==id||typeof r.phase!=='string'||!['keywords','select','judge'].includes(r.phase)||!Array.isArray(r.originalCallIds)||!r.originalCallIds.length||r.originalCallIds.length>10000)invalid();
 const originalCallIds=list(r.originalCallIds,10000,1).map(uuid),retryCallId=uuid(r.retryCallId);
 if(new Set(originalCallIds).size!==originalCallIds.length||originalCallIds.includes(retryCallId)||JSON.stringify(originalCallIds)!==JSON.stringify([...originalCallIds].sort()))invalid();
 return{version:1,operationId:id,phase:r.phase as CategoryRepairClaim['phase'],originalCallIds,retryCallId,inputVersion:sha256(r.inputVersion),candidateSnapshotSha256:sha256(r.candidateSnapshotSha256),continuedAt:date(r.continuedAt)};
}
function snapshot(raw:unknown,requestId:string):CategoryExpansionSnapshot {
 const s=record(raw,['version','candidates','evidence','candidateSnapshotSha256','sha256','requestId','receiptSha256','receivedAt']);
 if(s.version!==1||s.requestId!==requestId||!Array.isArray(s.candidates)||s.candidates.length>50||!Array.isArray(s.evidence)||s.evidence.length!==s.candidates.length)invalid();
 const candidates=list(s.candidates,50).map(raw=>{const c=record(raw,['name','displayName']);return{name:boundedText(c.name,100),displayName:boundedText(c.displayName,1000)};});
 const evidence=list(s.evidence,50).map((raw,index)=>{const e=record(raw,['name','hitKeywords','sources']);if(e.name!==candidates[index].name)invalid();
  const hitKeywords=list(e.hitKeywords,8).map(word=>boundedText(word,100)),rawSources=list(e.sources,2,1);if(rawSources.some(source=>source!=='local'&&source!=='platform'))invalid();const sources=rawSources as ('local'|'platform')[];if(new Set(hitKeywords).size!==hitKeywords.length||new Set(sources).size!==sources.length)invalid();return{name:candidates[index].name,hitKeywords,sources:[...sources]};});
 const candidateSnapshotSha256=categoryCandidateSnapshot(candidates),contentSha256=listingFingerprint({candidates,evidence});
 if(s.candidateSnapshotSha256!==candidateSnapshotSha256||s.sha256!==contentSha256)invalid();
 return{version:1,candidates,evidence,candidateSnapshotSha256,sha256:contentSha256,requestId,receiptSha256:sha256(s.receiptSha256),receivedAt:date(s.receivedAt)};
}
function expansion(raw:unknown,id:string):CategoryExpansionOperation {
 const e=record(raw,['version','operationId','inputVersion','originalDecisionId','originalCallId','fromCandidateSnapshotSha256','claimedAt','requestId','targetId','query','requestSha256','permittedAt','snapshot'],['captureProof']);
 if(e.version!==1||e.operationId!==id)invalid();const claimedAt=date(e.claimedAt),permittedAt=e.permittedAt===null?null:date(e.permittedAt),requestId=uuid(e.requestId),received=e.snapshot===null?null:snapshot(e.snapshot,requestId);
 if(permittedAt!==null&&permittedAt<claimedAt||received&&(!permittedAt||received.receivedAt<permittedAt))invalid();
 const targetId=boundedText(e.targetId,100),query=boundedText(e.query,1000),requestSha256=listingFingerprint({method:'GET',targetId,query});if(e.requestSha256!==requestSha256)invalid();
 const value:CategoryExpansionOperation={version:1,operationId:id,inputVersion:sha256(e.inputVersion),originalDecisionId:uuid(e.originalDecisionId),originalCallId:uuid(e.originalCallId),fromCandidateSnapshotSha256:sha256(e.fromCandidateSnapshotSha256),claimedAt,requestId,targetId,query,requestSha256,permittedAt,snapshot:received};
 if(Object.hasOwn(e,'captureProof')){value.captureProof=captureProof(e.captureProof,value);if(received&&received.receiptSha256!==value.captureProof.receiptSha256)invalid();}return value;
}
function captureProof(raw:unknown,owner:CategoryExpansionOperation):CategoryExpansionCaptureProof {
 const p=record(raw,['version','operationId','inputVersion','requestId','requestSha256','targetScope','targetGeneration','query','status','remoteRequestId','receivedAt','receiptSha256','byteSize','fileSha256','fileByteSize']),target=record(p.targetScope,['targetId','sellerId','marketplaceId','region','locale','mode']);
 if(p.version!==1||!owner.permittedAt||p.operationId!==owner.operationId||p.inputVersion!==owner.inputVersion||p.requestId!==owner.requestId||p.requestSha256!==owner.requestSha256||p.query!==owner.query||target.targetId!==owner.targetId||typeof target.region!=='string'||!['na','eu','fe'].includes(target.region)||typeof target.mode!=='string'||!['live','demo'].includes(target.mode)||!Number.isSafeInteger(p.targetGeneration)||Number(p.targetGeneration)<1||!Number.isInteger(p.status)||Number(p.status)<100||Number(p.status)>599||!Number.isSafeInteger(p.byteSize)||Number(p.byteSize)<0||Number(p.byteSize)>2*1024*1024||!Number.isSafeInteger(p.fileByteSize)||Number(p.fileByteSize)<1||Number(p.fileByteSize)>4*1024*1024||p.remoteRequestId!==null&&(typeof p.remoteRequestId!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/.test(p.remoteRequestId)))invalid();
 const receivedAt=date(p.receivedAt);if(receivedAt<owner.permittedAt)invalid();
 return {version:1,operationId:owner.operationId,inputVersion:owner.inputVersion,requestId:owner.requestId,requestSha256:owner.requestSha256,targetScope:{targetId:owner.targetId,sellerId:boundedText(target.sellerId,200),marketplaceId:boundedText(target.marketplaceId,100),region:target.region as 'na'|'eu'|'fe',locale:boundedText(target.locale,100),mode:target.mode as 'live'|'demo'},targetGeneration:Number(p.targetGeneration),query:owner.query,status:Number(p.status),remoteRequestId:p.remoteRequestId as string|null,receivedAt,receiptSha256:sha256(p.receiptSha256),byteSize:Number(p.byteSize),fileSha256:sha256(p.fileSha256),fileByteSize:Number(p.fileByteSize)};
}
export function parseCategoryOperation(raw:unknown):CategoryOperationRecord {
 const o=record(raw,['version','id','productId','repairs','expansion']),productId=uuid(o.productId),id=categoryOperationId(productId);
 if(o.version!==1||o.id!==id)invalid();const repairs=list(o.repairs,3).map(raw=>repair(raw,id));if(new Set(repairs.map(r=>r.phase)).size!==repairs.length)invalid();repairs.sort((a,b)=>a.phase.localeCompare(b.phase));
 return{version:1,id,productId,repairs,expansion:o.expansion===null?null:expansion(o.expansion,id)};
}
export function newCategoryOperation(productId:string):CategoryOperationRecord{return parseCategoryOperation({version:1,id:categoryOperationId(productId),productId,repairs:[],expansion:null});}
export function addCategoryRepair(raw:unknown,claim:unknown):CategoryOperationRecord {
 const operation=parseCategoryOperation(raw),next=repair(claim,operation.id);if(operation.repairs.some(prior=>prior.phase===next.phase))invalid();return parseCategoryOperation({...operation,repairs:[...operation.repairs,next]});
}
type ExpandedOperation=CategoryOperationRecord&{expansion:CategoryExpansionOperation};
export function addCategoryExpansion(raw:unknown,claim:unknown):ExpandedOperation {
 const operation=parseCategoryOperation(raw),next=expansion(claim,operation.id);if(operation.expansion||next.permittedAt!==null||next.snapshot!==null)invalid();return{...operation,expansion:next};
}
export function permitCategoryExpansion(raw:unknown,requestId:string,at:string):ExpandedOperation {
 const operation=parseCategoryOperation(raw),prior=operation.expansion;if(!prior||prior.requestId!==uuid(requestId)||prior.permittedAt!==null)invalid();return{...operation,expansion:expansion({...prior,permittedAt:date(at)},operation.id)};
}
export function completeCategoryExpansion(raw:unknown,received:unknown):ExpandedOperation {
 const operation=parseCategoryOperation(raw),prior=operation.expansion;if(!prior||!prior.permittedAt)invalid();const next=expansion({...prior,snapshot:received},operation.id);if(prior.snapshot&&listingFingerprint(prior.snapshot)!==listingFingerprint(next.snapshot))invalid();return{...operation,expansion:next};
}
export function freezeCategoryExpansionCapture(raw:unknown,received:unknown):ExpandedOperation {
 const operation=parseCategoryOperation(raw),prior=operation.expansion;if(!prior||!prior.permittedAt)invalid();const proof=captureProof(received,prior);
 if(prior.captureProof&&listingFingerprint(prior.captureProof)!==listingFingerprint(proof))invalid();return {...operation,expansion:expansion({...prior,captureProof:prior.captureProof??proof},operation.id)};
}
/** Restore is an immutable union, never a reset of a claimed or permitted effect. */
export function mergeCategoryOperations(left:unknown,right:unknown):CategoryOperationRecord {
 const a=parseCategoryOperation(left),b=parseCategoryOperation(right);if(a.id!==b.id||a.productId!==b.productId)invalid();
 const repairs=new Map(a.repairs.map(claim=>[claim.phase,claim]));for(const claim of b.repairs){const old=repairs.get(claim.phase);if(old&&listingFingerprint(old)!==listingFingerprint(claim))invalid();repairs.set(claim.phase,claim);}
 let merged=a.expansion??b.expansion;
 if(a.expansion&&b.expansion){const {permittedAt:ap,snapshot:as,captureProof:ac,...ai}=a.expansion,{permittedAt:bp,snapshot:bs,captureProof:bc,...bi}=b.expansion;if(listingFingerprint(ai)!==listingFingerprint(bi)||ap&&bp&&ap!==bp||as&&bs&&listingFingerprint(as)!==listingFingerprint(bs)||ac&&bc&&listingFingerprint(ac)!==listingFingerprint(bc))invalid();merged={...ai,permittedAt:ap??bp,snapshot:as??bs,...(ac??bc?{captureProof:ac??bc}:{})};}
 return parseCategoryOperation({...a,repairs:[...repairs.values()],expansion:merged});
}
