import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from './database.ts';

export type StartupReceiptCodec={encode:(text:string)=>string;decode:(text:string)=>string};
type FileProof={size:number;sha256:string};
type Receipt={version:1;build:string;schema:number;database:FileProof;wal:FileProof|null;snapshot:string;snapshotProof:FileProof};
const receiptName='startup-clean.enc';
async function proof(path:string):Promise<FileProof>{
  const before=await lstat(path);
  if(!before.isFile()||before.isSymbolicLink())throw Error('Invalid startup file');
  const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);
  const after=await lstat(path);
  if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||before.ino!==after.ino)throw Error('Startup file changed');
  return{size:after.size,sha256:hash.digest('hex')};
}
async function walProof(root:string):Promise<FileProof|null>{try{return await proof(join(root,'red.sqlite-wal'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
function same(a:FileProof|null,b:FileProof|null){return a===null?b===null:!!b&&a.size===b.size&&a.sha256===b.sha256;}
function quickSchema(root:string):void{
  const db=new DatabaseSync(join(root,'red.sqlite'),{readOnly:true});
  try{
    if(Number(db.prepare('PRAGMA user_version').get()?.user_version)!==SCHEMA_VERSION)throw Error('Schema changed');
    for(const table of ['products','variants','facts','assets','audit_events'])db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
  }finally{db.close();}
}
/** Consumed before restore recovery or service construction. A crash cannot reuse a clean marker. */
export async function consumeStartupReceipt(directory:string,build:string,codec?:StartupReceiptCodec):Promise<{mode:'quick'|'full'}>{
  const root=resolve(directory),path=join(root,receiptName);
  try{
    if((await lstat(root)).isSymbolicLink())throw Error('Invalid workspace folder');
    const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32768)throw Error('Invalid credential');
    const encoded=await readFile(path,'utf8');await unlink(path);
    if(!codec)return{mode:'full'};
    const receipt=JSON.parse(codec.decode(encoded)) as Receipt;
    if(receipt.version!==1||receipt.build!==build||receipt.schema!==SCHEMA_VERSION||typeof receipt.snapshot!=='string'||basename(receipt.snapshot)!==receipt.snapshot)throw Error('Credential changed');
    const snapshot=join(root,'database-snapshots',receipt.snapshot);
    if((await lstat(dirname(snapshot))).isSymbolicLink())throw Error('Invalid snapshot folder');
    // Hashing is streamed off the event loop; unchanged content must match the verified shutdown.
    const database=await proof(join(root,'red.sqlite')),wal=await walProof(root);
    if(!same(database,receipt.database)||!same(wal,receipt.wal)||!same(await proof(snapshot),receipt.snapshotProof))throw Error('Workspace changed');
    quickSchema(root);
    return{mode:'quick'};
  }catch{
    try{await unlink(path);}catch{/* A missing or unreadable credential always means full validation. */}
    return{mode:'full'};
  }
}
/** Only call after all services closed, full history validation and a verified snapshot succeeded. */
export async function saveCleanShutdownReceipt(directory:string,build:string,snapshot:string,codec?:StartupReceiptCodec):Promise<void>{
  if(!codec)return;
  const root=resolve(directory);if(resolve(dirname(snapshot))!==join(root,'database-snapshots'))throw Error('Invalid snapshot location');
  if((await lstat(root)).isSymbolicLink()||(await lstat(dirname(snapshot))).isSymbolicLink())throw Error('Invalid workspace folder');
  quickSchema(root);
  const receipt:Receipt={version:1,build,schema:SCHEMA_VERSION,database:await proof(join(root,'red.sqlite')),wal:await walProof(root),snapshot:basename(snapshot),snapshotProof:await proof(snapshot)};
  const temporary=join(root,receiptName+'.partial');
  try{await writeFile(temporary,codec.encode(JSON.stringify(receipt)),{flag:'wx'});await rename(temporary,join(root,receiptName));}
  finally{try{await unlink(temporary);}catch{/* Incomplete credentials cannot be used on startup. */}}
}
