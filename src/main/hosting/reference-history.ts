import type {DatabaseSync} from 'node:sqlite';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {validateReferencePin,referencePinArtifactPaths,referencePinProtects,type ReferencePin} from './reference-pins.ts';
import {RestorePathGuard,writeRestoreFile} from '../restore-paths.ts';
import type {RetentionOwner} from '../reference-retention.ts';
import {UserFacingError} from '../../shared/errors.ts';
const fail=():never=>{throw new UserFacingError('参考图保留历史冲突或文件损坏，未覆盖已有版本');};
export function referencePinHistory(db:DatabaseSync):ReferencePin[]{
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_reference_pins'").get())return[];
 const identities=new Set<string>();return db.prepare('SELECT id,record_json FROM image_reference_pins').all().map(row=>{
  const pin=validateReferencePin(JSON.parse(String(row.record_json))),identity=`${pin.operationId}:${pin.assetId}`;
  if(pin.id!==row.id||identities.has(identity))fail();identities.add(identity);return pin;
 });
}
const immutable=(p:ReferencePin)=>JSON.stringify([p.id,p.operationId,p.assetId,p.sha256,p.sourceKind,p.sourceVersion,p.originalPath,p.byteSize,p.mimeType,p.purpose,p.createdAt]);
export function retainReferencePinHistory(current:DatabaseSync,snapshot:DatabaseSync,currentRoot:string,stageRoot:string){
 const source=new RestorePathGuard(currentRoot),target=new RestorePathGuard(stageRoot),existing=new Map(referencePinHistory(snapshot).map(pin=>[pin.id,pin]));
 for(const pin of referencePinHistory(current)){
  const prior=existing.get(pin.id);if(prior&&(immutable(prior)!==immutable(pin)||prior.url&&pin.url&&prior.url!==pin.url))fail();
  const best=pin.state==='READY'?pin:prior?.state==='READY'?prior:pin;
  const merged=validateReferencePin({...best,retainedUntil:prior&&prior.retainedUntil>pin.retainedUntil?prior.retainedUntil:pin.retainedUntil,attempts:Math.max(pin.attempts,prior?.attempts??0),releasedAt:prior?(prior.releasedAt===null||pin.releasedAt===null?null:prior.releasedAt>pin.releasedAt?prior.releasedAt:pin.releasedAt):pin.releasedAt});
  for(const path of referencePinArtifactPaths(pin)){
   const from=join(currentRoot,path),to=join(stageRoot,path);const before=source.assertFile(from);if(before.size>20*1024*1024)fail();const bytes=readFileSync(from);const after=source.assertFile(from);if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)fail();
   const hash=createHash('sha256').update(bytes).digest('hex');if(path===pin.originalPath&&(hash!==pin.sha256||bytes.length!==pin.byteSize))fail();
   if(existsSync(to)){target.assertFile(to);if(createHash('sha256').update(readFileSync(to)).digest('hex')!==hash)fail();}else writeRestoreFile(target,to,bytes);
  }
  snapshot.prepare('INSERT INTO image_reference_pins(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(merged.id,JSON.stringify(merged));existing.set(merged.id,merged);
 }
 referencePinHistory(snapshot);
}
export const referencePinRetentionOwner:RetentionOwner={tables:['image_reference_pins'],protects(db,path,now){return referencePinHistory(db).some(pin=>referencePinProtects(pin,now)&&(referencePinArtifactPaths(pin).includes(path)||pin.sourceKind==='source'&&path.startsWith(`assets/${pin.assetId}.`)));}};
