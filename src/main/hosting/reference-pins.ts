import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {BatchReference} from '../../shared/ai-batch-contracts.ts';
import {boundedText,date,integer,keys,sha256,uuid} from '../ai/primitives.ts';
import {UserFacingError} from '../../shared/errors.ts';
import {validatePublicUrl} from './public-probe.ts';

export const REFERENCE_PIN_TABLES=['image_reference_pins'] as const;
/** 24 h remote window + 24 h retrieval/recovery + 24 h cleanup buffer. No automatic deletion. */
export const REFERENCE_RETENTION_MS=72*3600_000;
export interface ReferenceVersion {assetId:string;sha256:string;sourceKind:'source'|'candidate';sourceVersion:string;originalPath:string;byteSize:number;mimeType:'image/png'|'image/jpeg'}
export interface ReferencePin extends ReferenceVersion {id:string;version:1;operationId:string;purpose:'source-reference'|'candidate-review';state:'PENDING'|'READY'|'FAILED';url:string|null;createdAt:string;retainedUntil:string;releasedAt:string|null;attempts:number}
const fail=():never=>{throw new UserFacingError('参考图版本或保留凭证无效，未切换来源');};
export function validateReferenceVersion(raw:unknown):ReferenceVersion{
 const v=keys(raw,['assetId','sha256','sourceKind','sourceVersion','originalPath','byteSize','mimeType']);
 if(!['source','candidate'].includes(String(v.sourceKind))||!['image/png','image/jpeg'].includes(String(v.mimeType))||typeof v.originalPath!=='string'||!v.originalPath.length||v.originalPath.length>500||v.originalPath.includes('\\')||v.originalPath.startsWith('/')||v.originalPath.includes(':')||v.originalPath.split('/').some(part=>!part||part==='.'||part==='..'))fail();
 if(v.sourceKind==='candidate'&&v.originalPath!==`image-generation/candidates/${uuid(v.assetId)}/image.png`||v.sourceKind==='source'&&v.originalPath!==`assets/${uuid(v.assetId)}.${v.mimeType==='image/png'?'png':'jpg'}`)fail();
 return{assetId:uuid(v.assetId),sha256:sha256(v.sha256),sourceKind:v.sourceKind as ReferenceVersion['sourceKind'],sourceVersion:boundedText(v.sourceVersion,200),originalPath:v.originalPath as string,byteSize:integer(v.byteSize,1,20*1024*1024),mimeType:v.mimeType as ReferenceVersion['mimeType']};
}
export function validateReferencePin(raw:unknown):ReferencePin{
 const p=keys(raw,['id','version','operationId','purpose','state','url','createdAt','retainedUntil','releasedAt','attempts','assetId','sha256','sourceKind','sourceVersion','originalPath','byteSize','mimeType']);
 if(p.version!==1||!['source-reference','candidate-review'].includes(String(p.purpose))||!['PENDING','READY','FAILED'].includes(String(p.state)))fail();
 const v=validateReferenceVersion(Object.fromEntries(['assetId','sha256','sourceKind','sourceVersion','originalPath','byteSize','mimeType'].map(k=>[k,p[k]])));
 if((p.purpose==='source-reference')!==(v.sourceKind==='source'))fail();
 const createdAt=date(p.createdAt),retainedUntil=date(p.retainedUntil),releasedAt=p.releasedAt===null?null:date(p.releasedAt);
 if(Date.parse(retainedUntil)-Date.parse(createdAt)<REFERENCE_RETENTION_MS||releasedAt&&releasedAt<createdAt)fail();
 if(p.url!==null&&(typeof p.url!=='string'||validatePublicUrl(p.url).protocol!=='https:'||!new URL(p.url).pathname.includes(v.sha256)||new URL(p.url).search||new URL(p.url).hash))fail();
 if((p.state==='READY')!==(p.url!==null))fail();
 return{...v,id:uuid(p.id),version:1,operationId:uuid(p.operationId),purpose:p.purpose as ReferencePin['purpose'],state:p.state as ReferencePin['state'],url:p.url as string|null,createdAt,retainedUntil,releasedAt,attempts:integer(p.attempts,0,Number.MAX_SAFE_INTEGER)};
}
export function referencePinArtifactPaths(raw:unknown):string[]{const p=validateReferencePin(raw);return p.sourceKind==='candidate'?[p.originalPath,`image-generation/candidates/${p.assetId}/candidate.json`,`image-generation/candidates/${p.assetId}/preview.png`]:[p.originalPath];}
export function referencePinProtects(raw:unknown,now=new Date()):boolean{const p=validateReferencePin(raw);return p.releasedAt===null||Date.parse(p.retainedUntil)>now.getTime();}
export interface ReferencePinDependencies {
 now?:()=>Date;
 /** Resolve a managed immutable source/candidate version and read verified local bytes. Never accept renderer paths. */
 readVersion:(assetId:string,sha256:string)=>Promise<{version:ReferenceVersion;bytes:Buffer}>;
 uploadVersion:(version:ReferenceVersion,bytes:Buffer,signal:AbortSignal)=>Promise<string>;
 probe:(input:{url:string;sha256:string;byteSize:number;mimeType:string},signal:AbortSignal)=>Promise<void>;
}
export class ReferencePinService{
 private db:DatabaseSync;private deps:ReferencePinDependencies;private active=new Map<string,Promise<ReferencePin>>();
 constructor(db:DatabaseSync,deps:ReferencePinDependencies){this.db=db;this.deps=deps;}
 private now(){return this.deps.now?.()??new Date();}
 list(){return this.db.prepare('SELECT id,record_json FROM image_reference_pins').all().map(r=>{const p=validateReferencePin(JSON.parse(String(r.record_json)));if(p.id!==r.id)fail();return p;});}
 get(id:string){const p=this.list().find(p=>p.id===uuid(id));return p??fail();}
 private save(raw:ReferencePin){const p=validateReferencePin(raw),row=this.db.prepare('SELECT record_json FROM image_reference_pins WHERE id=?').get(p.id);if(row){const previous=validateReferencePin(JSON.parse(String(row.record_json)));if(Date.parse(previous.retainedUntil)>Date.parse(p.retainedUntil))p.retainedUntil=previous.retainedUntil;p.releasedAt=previous.releasedAt??p.releasedAt;}this.db.prepare('INSERT INTO image_reference_pins(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(p.id,JSON.stringify(p));return p;}
 reference(id:string):BatchReference{const p=this.get(id);if(p.state!=='READY'||!p.url)fail();return{pinId:p.id,assetId:p.assetId,sha256:p.sha256,url:p.url!,retainedUntil:p.retainedUntil};}
 validateReference(ref:BatchReference):boolean{try{const p=this.get(ref.pinId);return p.state==='READY'&&p.releasedAt===null&&p.assetId===ref.assetId&&p.sha256===ref.sha256&&p.url===ref.url&&Date.parse(p.retainedUntil)>=Date.parse(ref.retainedUntil)&&Date.parse(ref.retainedUntil)>=this.now().getTime()+48*3600_000;}catch{return false;}}
 protects(assetId:string,hash?:string){return this.list().some(p=>p.assetId===assetId&&(!hash||p.sha256===hash)&&referencePinProtects(p,this.now()));}
 assertCanRemove(assetId:string,hash?:string){if(this.protects(assetId,hash))throw new UserFacingError('图片仍被批量任务引用或处于回收缓冲期，不能删除或覆盖');}
 /** Caller may release only after domain collection/cancellation is resolved. UNKNOWN must keep its pin. */
 release(id:string){const p=this.get(id);return this.save({...p,releasedAt:p.releasedAt??this.now().toISOString()});}
 prepare(input:{operationId:string;assetId:string;sha256:string;purpose:ReferencePin['purpose']},signal=new AbortController().signal):Promise<ReferencePin>{
 keys(input,['operationId','assetId','sha256','purpose']);
 const operationId=uuid(input.operationId),assetId=uuid(input.assetId),hash=sha256(input.sha256),key=`${operationId}:${assetId}:${hash}:${input.purpose}`;
 const existing=this.active.get(key);if(existing)return existing;
 const promise=this.run({...input,operationId,assetId,sha256:hash},signal).finally(()=>this.active.delete(key));this.active.set(key,promise);return promise;
 }
 private async run(input:{operationId:string;assetId:string;sha256:string;purpose:ReferencePin['purpose']},signal:AbortSignal){
 signal.throwIfAborted();const {version:raw,bytes}=await this.deps.readVersion(input.assetId,input.sha256),version=validateReferenceVersion(raw);
 if(version.assetId!==input.assetId||version.sha256!==input.sha256||bytes.length!==version.byteSize||createHash('sha256').update(bytes).digest('hex')!==version.sha256)fail();
 let p=this.list().find(p=>p.operationId===input.operationId&&p.assetId===input.assetId);
 if(p&&(p.sha256!==input.sha256||p.purpose!==input.purpose||p.sourceVersion!==version.sourceVersion||p.originalPath!==version.originalPath||p.releasedAt))fail();
 if(!p){const now=this.now();p=this.save({...version,...input,id:randomUUID(),version:1,state:'PENDING',url:null,createdAt:now.toISOString(),retainedUntil:new Date(now.getTime()+REFERENCE_RETENTION_MS).toISOString(),releasedAt:null,attempts:0});}
 // Renew the same version's promise before upload/probe; never reset identity, creation time or attempts.
 const retainedUntil=new Date(Math.max(Date.parse(p.retainedUntil),this.now().getTime()+REFERENCE_RETENTION_MS)).toISOString();
 if(retainedUntil!==p.retainedUntil)p=this.save({...p,retainedUntil});
 if(p.state==='READY'){await this.deps.probe({url:p.url!,sha256:p.sha256,byteSize:p.byteSize,mimeType:p.mimeType},signal);return this.get(p.id);}
 p=this.save({...p,state:'PENDING',attempts:p.attempts+1});
 try{const url=await this.deps.uploadVersion(version,bytes,signal);signal.throwIfAborted();const ready=validateReferencePin({...p,state:'READY',url});await this.deps.probe({url,sha256:p.sha256,byteSize:p.byteSize,mimeType:p.mimeType},signal);signal.throwIfAborted();return this.save(ready);}catch(error){this.save({...p,state:'FAILED',url:null});throw error;}
 }
}

