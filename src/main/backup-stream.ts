import { RestorePathGuard } from './restore-paths.ts';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { constants, writeSync, fsyncSync, closeSync } from 'node:fs';
import { open, lstat, realpath, link, unlink, statfs } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { UserFacingError } from '../shared/errors.ts';
import type { BackupRetention } from './backup-retention.ts';

export const V2_MAGIC = Buffer.from('HTC-BACKUP-2\n');
export const BACKUP_CHUNK_BYTES = 1024 * 1024;
const MAX_MANIFEST = 16 * 1024 * 1024;
export interface BackupFile { path: string; byteSize: number; sha256: string; role: string }
export interface StreamManifest { format: 'htc-workspace-backup'; version: 2; source: { application: 'HTC'; kind: 'local-workspace'; databaseVersion: number }; createdAt: string; retention: BackupRetention; files: BackupFile[] }
export type BackupCheckpoint = (point: 'chunk-written' | 'before-publish' | 'file-restored') => void | Promise<void>;
function invalid(): UserFacingError { return new UserFacingError('口令不正确或备份已经损坏，当前工作区未更改'); }
async function keyFor(passphrase:string,salt:Buffer):Promise<Buffer>{ return new Promise((ok,no)=>scrypt(passphrase,salt,32,{N:16384,r:8,p:1,maxmem:64*1024*1024},(e,k)=>e?no(e):ok(k))); }
function same(a: Awaited<ReturnType<typeof lstat>>, b: Awaited<ReturnType<typeof lstat>>): boolean {return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;}
async function regular(path:string):Promise<Awaited<ReturnType<typeof lstat>>>{const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||(await realpath(path)).toLowerCase()!==resolve(path).toLowerCase())throw invalid();return s;}
async function exact(file:FileHandle,size:number):Promise<Buffer>{ const bytes=Buffer.alloc(size);let offset=0;while(offset<size){const r=await file.read(bytes,offset,size-offset,null);if(!r.bytesRead)throw invalid();offset+=r.bytesRead;}return bytes; }
async function write(file:FileHandle,bytes:Buffer):Promise<void>{let offset=0;while(offset<bytes.length){const r=await file.write(bytes,offset,bytes.length-offset,null);if(!r.bytesWritten)throw new Error('Backup disk write failed');offset+=r.bytesWritten;}}
export async function hashBackupFile(path:string):Promise<{sha256:string;byteSize:number}>{const before=await regular(path),file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));try{if(!same(before,await file.stat()))throw invalid();const hash=createHash('sha256'),buffer=Buffer.alloc(BACKUP_CHUNK_BYTES);let size=0;for(;;){const r=await file.read(buffer,0,buffer.length,null);if(!r.bytesRead)break;hash.update(buffer.subarray(0,r.bytesRead));size+=r.bytesRead;}if(size!==before.size||!same(before,await file.stat())||!same(before,await regular(path)))throw invalid();return{sha256:hash.digest('hex'),byteSize:size};}finally{await file.close();}}
export async function checkBackupSpace(directory:string,bytes:number):Promise<void>{const disk=await statfs(directory);if(disk.bavail*disk.bsize<bytes+16*1024*1024)throw new UserFacingError('磁盘可用空间不足，当前工作区及上次备份未更改');}
function validateManifest(value:unknown):asserts value is StreamManifest{
 const m=value as StreamManifest;if(!m||m.format!=='htc-workspace-backup'||m.version!==2||m.source?.application!=='HTC'||m.source?.kind!=='local-workspace'||!Number.isSafeInteger(m.source.databaseVersion)||m.source.databaseVersion<1||typeof m.createdAt!=='string'||!Number.isFinite(Date.parse(m.createdAt))||!m.retention||!Array.isArray(m.files)||m.files.length<1||m.files.length>20001)throw invalid();
 const paths=new Set<string>();let total=0;for(const f of m.files){if(!f||typeof f.path!=='string'||f.path.length>1024||!/^(red\.sqlite|(?:assets|documents|ai-receipts)\/[a-zA-Z0-9_./-]+)$/.test(f.path)||f.path.split('/').some(p=>!p||p==='.'||p==='..')||paths.has(f.path.toLowerCase())||!Number.isSafeInteger(f.byteSize)||f.byteSize<0||!/^[a-f0-9]{64}$/.test(f.sha256)||typeof f.role!=='string')throw invalid();paths.add(f.path.toLowerCase());total+=f.byteSize;if(!Number.isSafeInteger(total))throw invalid();}if(m.files[0].path!=='red.sqlite')throw invalid();
}
/** Immutable manifest is authenticated before any file. Every frame authenticates sequence,
 * length, file identity, header and manifest hash. Final empty frame makes truncation fatal. */
export async function writeStreamingBackup(destination:string,passphrase:string,manifest:StreamManifest,source:(path:string)=>string,beforePublish:(info:{sha256:string;byteSize:number})=>Promise<void>,checkpoint?:BackupCheckpoint):Promise<void>{
 validateManifest(manifest);const metadata=Buffer.from(JSON.stringify(manifest));if(metadata.length>MAX_MANIFEST)throw invalid();
 const header=Buffer.concat([V2_MAGIC,randomBytes(16),randomBytes(16)]),key=await keyFor(passphrase,header.subarray(13,29)),manifestHash=createHash('sha256').update(metadata).digest();
 const temporary=destination+'.partial-'+randomUUID();let file:FileHandle|undefined;let sequence=0,size=0;const hash=createHash('sha256');
 try{
 await checkBackupSpace(dirname(destination),manifest.files.reduce((n,f)=>n+f.byteSize,metadata.length)+manifest.files.length*64);file=await open(temporary,'wx');
 const put=async(b:Buffer)=>{await write(file!,b);hash.update(b);size+=b.length;};await put(header);
 const frame=async(plain:Buffer,owner:number)=>{if(sequence>=0xffffffff)throw invalid();const descriptor=Buffer.alloc(12);descriptor.writeUInt32BE(sequence,0);descriptor.writeUInt32BE(plain.length,4);descriptor.writeUInt32BE(owner,8);const nonce=Buffer.concat([header.subarray(29,37),descriptor.subarray(0,4)]);const cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.concat([header,descriptor,owner===0xffffffff?Buffer.alloc(32):manifestHash]));await put(descriptor);await put(cipher.update(plain));await put(cipher.final());await put(cipher.getAuthTag());sequence++;await checkpoint?.('chunk-written');};
 await frame(metadata,0xffffffff);
 for(let index=0;index<manifest.files.length;index++){const entry=manifest.files[index],path=source(entry.path),before=await regular(path),input=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));try{if(before.size!==entry.byteSize||!same(before,await input.stat()))throw invalid();const fileHash=createHash('sha256'),buffer=Buffer.alloc(BACKUP_CHUNK_BYTES);let count=0;while(count<entry.byteSize){const length=Math.min(buffer.length,entry.byteSize-count);let got=0;while(got<length){const r=await input.read(buffer,got,length-got,null);if(!r.bytesRead)throw invalid();got+=r.bytesRead;}const part=buffer.subarray(0,length);fileHash.update(part);await frame(part,index);count+=length;}if(fileHash.digest('hex')!==entry.sha256||!same(before,await input.stat())||!same(before,await regular(path)))throw invalid();}finally{await input.close();}}
 await frame(Buffer.alloc(0),0xfffffffe);await file.sync();await file.close();file=undefined;await checkpoint?.('before-publish');await beforePublish({sha256:hash.digest('hex'),byteSize:size});
 // Hard-link publication is atomic and exclusive: never replace a previous successful export.
 await link(temporary,destination);
 }finally{key.fill(0);await file?.close();await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
export async function readStreamingBackup(source:string,passphrase:string,staging:string,pathFor:(path:string)=>string,checkpoint?:BackupCheckpoint):Promise<StreamManifest>{
 const before=await regular(source),file=await open(source,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let key:Buffer|undefined;
 try{
 if(!same(before,await file.stat()))throw invalid();const header=await exact(file,45);if(!header.subarray(0,13).equals(V2_MAGIC))throw invalid();key=await keyFor(passphrase,header.subarray(13,29));let sequence=0;let manifestHash=Buffer.alloc(32);
 const frame=async(owner:number,max:number)=>{const descriptor=await exact(file,12),length=descriptor.readUInt32BE(4);if(descriptor.readUInt32BE(0)!==sequence||descriptor.readUInt32BE(8)!==owner||length>max||sequence>=0xffffffff)throw invalid();const ciphertext=await exact(file,length),tag=await exact(file,16),nonce=Buffer.concat([header.subarray(29,37),descriptor.subarray(0,4)]);const cipher=createDecipheriv('aes-256-gcm',key!,nonce);cipher.setAAD(Buffer.concat([header,descriptor,manifestHash]));cipher.setAuthTag(tag);const plain=Buffer.concat([cipher.update(ciphertext),cipher.final()]);sequence++;return plain;};
 const metadata=await frame(0xffffffff,MAX_MANIFEST);manifestHash=Buffer.from(createHash('sha256').update(metadata).digest());const manifest:unknown=JSON.parse(metadata.toString());validateManifest(manifest);
 // Validate every path before opening any output, including files later in the manifest.
 const paths=manifest.files.map(f=>pathFor(f.path));await checkBackupSpace(staging,manifest.files.reduce((n,f)=>n+f.byteSize,0));
 const guard = new RestorePathGuard(staging);
 for (let index = 0; index < manifest.files.length; index++) {
   const entry = manifest.files[index], path = paths[index], out = guard.openFile(path);
   try {
     const hash = createHash('sha256'); let count = 0;
     while (count < entry.byteSize) {
       const plain = await frame(index, Math.min(BACKUP_CHUNK_BYTES, entry.byteSize - count));
       if (!plain.length) throw invalid();
       guard.assertFile(path, out);
       let offset = 0;
       while (offset < plain.length) {
         const written = writeSync(out, plain, offset, plain.length - offset);
         if (!written) throw invalid(); offset += written;
       }
       guard.assertFile(path, out); hash.update(plain); count += plain.length;
     }
     if (hash.digest('hex') !== entry.sha256) throw invalid();
     guard.assertFile(path, out); fsyncSync(out);
   } finally { closeSync(out); }
   await checkpoint?.('file-restored');
 }
 guard.assertTree();
 if((await frame(0xfffffffe,0)).length)throw invalid();const tail=Buffer.alloc(1);if((await file.read(tail,0,1,null)).bytesRead||!same(before,await file.stat())||!same(before,await regular(source)))throw invalid();return manifest;
 }catch(error){if(error instanceof UserFacingError)throw error;throw invalid();}finally{key?.fill(0);await file.close();}
}

