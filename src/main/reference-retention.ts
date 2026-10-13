import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { readdir, lstat, realpath } from 'node:fs/promises';
import { lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { managedAssetPath } from './security.ts';
import { hashBackupFile } from './backup-stream.ts';
import { databaseReferences } from './retention-references.ts';
import { UserFacingError } from '../shared/errors.ts';
export interface RetentionCandidate { path:string; sha256:string; byteSize:number }
export interface RetentionPlan { planId:string; revision:string; automaticEnabled:false; candidates:RetentionCandidate[]; protected:number }
export interface RetentionOwner { tables?: readonly string[]; protects(db:DatabaseSync,path:string,now:Date):boolean }
/** Orphan asset deletion is explicit/manual only. Identity, fee, receipt and document
 * categories have no new retention policy. Plans are local, immutable and single-use. */
export class ReferenceRetention {
 private readonly plans:Map<string,RetentionPlan>;
 private readonly db:DatabaseSync;private readonly root:string;private readonly owners:readonly RetentionOwner[];
 constructor(db:DatabaseSync,directory:string,owners:readonly RetentionOwner[]=[],plans=new Map<string,RetentionPlan>()){this.db=db;this.root=resolve(directory);this.owners=owners;this.plans=plans;}
 private protected(path:string):boolean{
 const id=/^assets\/([a-f0-9-]{36})/.exec(path)?.[1];return databaseReferences(this.db,id?[path,id]:[path],this.owners.flatMap(owner=>[...(owner.tables??[])]))||this.owners.some(owner=>owner.protects(this.db,path,new Date()));
 }
 async preview(input:{mode:'manual'|'automatic'}):Promise<RetentionPlan>{
 if(!input||!['manual','automatic'].includes(input.mode))throw new UserFacingError('清理预览模式无效');
 const candidates:RetentionCandidate[]=[];let protectedCount=0;
 if(input.mode==='manual'){
 let names:string[]=[];try{names=await readdir(join(this.root,'assets'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 for(const name of names){const path='assets/'+name;if(!/^assets\/[a-f0-9-]{36}(?:\.preview)?\.(png|jpg)$/.test(path))continue;
 if(this.protected(path)){protectedCount++;continue;}const file=managedAssetPath(this.root,path),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||(await realpath(file)).toLowerCase()!==file.toLowerCase()){protectedCount++;continue;}candidates.push({path,...await hashBackupFile(file)});
 }
 }
 const revision=createHash('sha256').update(JSON.stringify(candidates)).digest('hex'),plan:RetentionPlan={planId:randomUUID(),revision,automaticEnabled:false,candidates,protected:protectedCount};
 if(this.plans.size>=100)this.plans.delete(this.plans.keys().next().value!);this.plans.set(plan.planId,structuredClone(plan));return plan;
 }
 async apply(input:{planId:string;revision:string}):Promise<{removed:number;protected:number;changed:number}>{
 const plan=this.plans.get(input?.planId);if(!plan||plan.revision!==input.revision)throw new UserFacingError('清理预览已失效，请重新预览');this.plans.delete(plan.planId);
 let removed=0,protectedCount=0,changed=0;
 for(const entry of plan.candidates){const path=managedAssetPath(this.root,entry.path);let before:Awaited<ReturnType<typeof lstat>>;let actual:Awaited<ReturnType<typeof hashBackupFile>>;try{before=await lstat(path);actual=await hashBackupFile(path);}catch{changed++;continue;}
 if(actual.sha256!==entry.sha256||actual.byteSize!==entry.byteSize){changed++;continue;}

 // No await between the authoritative reference check and unlink. The write lock
 // blocks another DB connection from adding references during the decision.
 this.db.exec('BEGIN IMMEDIATE');try{
 if(this.protected(entry.path)){protectedCount++;continue;}
 const after=lstatSync(path);if(after.isSymbolicLink()||!after.isFile()||after.nlink!==1||before.ino!==after.ino||before.dev!==after.dev||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||realpathSync(path).toLowerCase()!==path.toLowerCase()){changed++;continue;}
 unlinkSync(path);removed++;
 }finally{this.db.exec('COMMIT');}
 }
 return{removed,protected:protectedCount,changed};
 }
}
