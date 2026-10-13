import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { createWorkspaceBackup } from '../src/main/backup.ts';
test('new complete backups use authenticated streaming V2', async t => {
 await mkdir(resolve('.test-data'),{recursive:true}); const root=await mkdtemp(resolve('.test-data/v2-'));
 t.after(()=>rm(root,{recursive:true,force:true})); const dir=join(root,'data'); const db=new WorkspaceStore(dir);db.close();
 const file=join(root,'test.htcbackup');await createWorkspaceBackup(dir,file,'synthetic passphrase');
 assert.equal((await readFile(file)).subarray(0,13).toString(),'HTC-BACKUP-2\n');
});
import { writeFile, open, readdir } from 'node:fs/promises';
import { randomUUID, createHash, createCipheriv, scryptSync } from 'node:crypto';
import { prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { writeStreamingBackup, hashBackupFile, type StreamManifest } from '../src/main/backup-stream.ts';
async function fixture(t:test.TestContext){await mkdir(resolve('.test-data'),{recursive:true});const root=await mkdtemp(resolve('.test-data/v2-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('V2 >256 MiB streams source images and restores identical hashes with bounded RSS',async t=>{
 const root=await fixture(t),dir=join(root,'data'),out=join(root,'out'),file=join(root,'large.htcbackup');const store=new WorkspaceStore(dir),product=store.createProduct(),id=randomUUID();
 await mkdir(join(dir,'assets'));const asset=join(dir,'assets',id+'.png'),handle=await open(asset,'wx'),hash=createHash('sha256'),chunk=Buffer.alloc(1024*1024,97),mib=Number(process.env.HTC_BACKUP_TEST_MIB??272);
 for(let i=0;i<mib;i++){await handle.write(chunk);hash.update(chunk);}await handle.close();await writeFile(join(dir,'assets',id+'.preview.png'),'preview');
 store.addAssets({productId:product.id,revision:product.revision},[{id,fileName:'synthetic.png',mimeType:'image/png',width:100,height:100,byteSize:mib*chunk.length,originalPath:'assets/'+id+'.png',previewPath:'assets/'+id+'.preview.png',sha256:hash.digest('hex')}]);store.close();
 const base=process.memoryUsage().rss;let peak=base;const timer=setInterval(()=>{peak=Math.max(peak,process.memoryUsage().rss);},5);try{
 await createWorkspaceBackup(dir,file,'synthetic passphrase');const prepared=await prepareWorkspaceRestore(out,file,'synthetic passphrase');await commitWorkspaceRestore(out,prepared);
 assert.deepEqual(await hashBackupFile(join(out,'assets',id+'.png')),await hashBackupFile(asset));
 }finally{clearInterval(timer);}t.diagnostic(JSON.stringify({mib,baselineRssMiB:base/1048576,peakRssMiB:peak/1048576,deltaMiB:(peak-base)/1048576}));assert.ok(peak-base<200*1048576,'RSS growth must be independent of total file size');
});
test('V2 rejects truncation, reordered frames, ciphertext edits and trailing bytes without changing workspace',async t=>{
 const root=await fixture(t),dir=join(root,'data'),file=join(root,'good.htcbackup');const db=new WorkspaceStore(dir),p=db.createProduct();db.close();await createWorkspaceBackup(dir,file,'synthetic passphrase');const bytes=await readFile(file);
 let offset=45;const frames:Buffer[]=[];while(offset<bytes.length){const end=offset+12+bytes.readUInt32BE(offset+4)+16;frames.push(bytes.subarray(offset,end));offset=end;}
 const tamper=Buffer.from(bytes);tamper[bytes.length-20]^=1;const oversized=Buffer.from(bytes);oversized.writeUInt32BE(0x7fffffff,49);
 const reordered=Buffer.concat([bytes.subarray(0,45),frames[1],frames[0],...frames.slice(2)]);
 for(const data of [bytes.subarray(0,-1),tamper,oversized,reordered,Buffer.concat([bytes,Buffer.from('x')])]){const bad=join(root,randomUUID()+'.htcbackup');await writeFile(bad,data);await assert.rejects(prepareWorkspaceRestore(dir,bad,'synthetic passphrase'),/损坏/);const check=new WorkspaceStore(dir);assert.equal(check.getProduct(p.id).id,p.id);check.close();}
 assert.deepEqual(await readFile(file),bytes);assert.equal((await readdir(dir)).some(n=>n.startsWith('.restore-')),false);
});
test('authenticated malicious manifest paths are rejected before extraction',async t=>{
 const root=await fixture(t),dir=join(root,'data'),db=new WorkspaceStore(dir);db.close();const good=join(root,'good.htcbackup');await createWorkspaceBackup(dir,good,'synthetic passphrase');
 // Build an authenticated malicious first frame; it must fail path validation before needing file bytes.
 const header=Buffer.concat([Buffer.from('HTC-BACKUP-2\n'),Buffer.alloc(16,1),Buffer.alloc(16,2)]),key=scryptSync('synthetic passphrase',header.subarray(13,29),32);
 for(const path of ['assets/../../escape.png','C:/escape.png','assets/x/../bad.png','assets//bad.png']){const manifest={format:'htc-workspace-backup',version:2,source:{application:'HTC',kind:'local-workspace',databaseVersion:26},createdAt:new Date().toISOString(),retention:{},files:[{path:'red.sqlite',byteSize:0,sha256:'0'.repeat(64),role:'db'},{path,byteSize:0,sha256:'0'.repeat(64),role:'image'}]};
 const plain=Buffer.from(JSON.stringify(manifest)),desc=Buffer.alloc(12);desc.writeUInt32BE(plain.length,4);desc.writeUInt32BE(0xffffffff,8);const cipher=createCipheriv('aes-256-gcm',key,Buffer.concat([header.subarray(29,37),desc.subarray(0,4)]));cipher.setAAD(Buffer.concat([header,desc,Buffer.alloc(32)]));const bad=join(root,randomUUID()+'.htcbackup');await writeFile(bad,Buffer.concat([header,desc,cipher.update(plain),cipher.final(),cipher.getAuthTag()]));await assert.rejects(prepareWorkspaceRestore(dir,bad,'synthetic passphrase'),/损坏/);}
});
test('failed disk write or interrupted publication keeps previous backup and removes partial output',async t=>{
 const root=await fixture(t),source=join(root,'input');await writeFile(source,'synthetic');const entry={path:'red.sqlite',...await hashBackupFile(source),role:'db'},manifest:StreamManifest={format:'htc-workspace-backup',version:2,source:{application:'HTC',kind:'local-workspace',databaseVersion:26},createdAt:new Date().toISOString(),retention:{amazonDays:180,logDays:365,dataOldestAt:null,expiresAt:null},files:[entry]};
 const previous=join(root,'previous.htcbackup');await writeFile(previous,'last successful backup');
 for(const point of ['chunk-written','before-publish']){const out=join(root,randomUUID()+'.htcbackup');await assert.rejects(writeStreamingBackup(out,'synthetic passphrase',manifest,()=>source,async()=>{},p=>{if(p===point)throw Object.assign(new Error('synthetic ENOSPC/interruption'),{code:'ENOSPC'});}));assert.equal((await readdir(root)).some(n=>n.includes('.partial-')),false);}
 await assert.rejects(writeStreamingBackup(previous,'synthetic passphrase',manifest,()=>source,async()=>{}));assert.equal(await readFile(previous,'utf8'),'last successful backup');
});
import { symlink, link } from 'node:fs/promises';
test('V2 rejects directory junction escape and hard-linked input without touching targets',async t=>{
 const root=await fixture(t),outside=join(root,'outside'),linked=join(root,'linked');await mkdir(outside);await writeFile(join(outside,'source'),'protected evidence');
 await symlink(outside,linked,'junction');await assert.rejects(hashBackupFile(join(linked,'source')),/损坏/);assert.equal(await readFile(join(outside,'source'),'utf8'),'protected evidence');
 const hard=join(root,'hard');await link(join(outside,'source'),hard);await assert.rejects(hashBackupFile(hard),/损坏/);assert.equal(await readFile(join(outside,'source'),'utf8'),'protected evidence');
});
