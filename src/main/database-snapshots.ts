import { backup, DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { UserFacingError } from '../shared/errors.ts';
import { SCHEMA_VERSION } from './database.ts';

function check(db: DatabaseSync): void {
 const version=Number(db.prepare('PRAGMA user_version').get()?.user_version);
 if(version<1||version>SCHEMA_VERSION)throw Error('Invalid workspace schema');
 const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
 if(['products','variants','facts','assets','audit_events'].some(name=>!tables.has(name)))throw Error('Missing workspace tables');
 const rows=db.prepare('PRAGMA integrity_check').all();
 if(rows.length!==1||rows[0].integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Invalid database');
}

/** Called under the application's single-instance lock, before opening services and after closing them.
 * Controlled acceptance still creates verified safety snapshots, but must not prune existing files. */
export async function snapshotWorkspaceDatabase(directory: string,{prune=true}:{prune?:boolean}={}): Promise<string|null> {
 const root=resolve(directory), sourcePath=join(root,'red.sqlite');
 if(!existsSync(sourcePath))return null;
 let source:DatabaseSync|undefined, snapshot:DatabaseSync|undefined, temporary:string|undefined;
 try {
  if(lstatSync(root).isSymbolicLink()||!lstatSync(sourcePath).isFile()||lstatSync(sourcePath).isSymbolicLink()||lstatSync(sourcePath).size<100)throw Error('Invalid path');
  source=new DatabaseSync(sourcePath,{readOnly:true});check(source);
  const folder=join(root,'database-snapshots');
  if(existsSync(folder)&&(!lstatSync(folder).isDirectory()||lstatSync(folder).isSymbolicLink()))throw Error('Invalid snapshots path');
  mkdirSync(folder,{recursive:true});
  const name=new Date().toISOString().replaceAll(':','-')+'-'+randomUUID()+'.sqlite', finalPath=join(folder,name);
  temporary=finalPath+'.partial';await backup(source,temporary);source.close();source=undefined;
  // Convert only the completed backup to a standalone file; never change the source journal mode.
  snapshot=new DatabaseSync(temporary);snapshot.exec('PRAGMA journal_mode=DELETE');check(snapshot);snapshot.close();snapshot=undefined;
  renameSync(temporary,finalPath);temporary=undefined;
  // Only prune snapshots created by this module, after a new verified snapshot exists.
  if(prune){const saved=readdirSync(folder).filter(n=>/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9-]{36}\.sqlite$/.test(n)).sort().reverse();
  for(const name of saved.slice(10)){const file=join(folder,name);if(lstatSync(file).isFile()&&!lstatSync(file).isSymbolicLink())unlinkSync(file);}}
  return finalPath;
 } catch {
  throw new UserFacingError('数据库完整性检查未通过或安全快照无法保存，已停止启动以保护现有商品。请保留工作区和 database-snapshots 目录，不要重置数据。');
 } finally {
  snapshot?.close();source?.close();
  if(temporary)for(const suffix of ['','-wal','-shm']){try{unlinkSync(temporary+suffix);}catch{/* Keep failed snapshots isolated from verified files. */}}
 }
}
