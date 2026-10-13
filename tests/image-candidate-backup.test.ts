import {openDatabase} from '../src/main/database.ts';
import {referencePinHistory,referencePinRetentionOwner} from '../src/main/hosting/reference-history.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {WorkspaceStore} from '../src/main/store.ts';
import {createWorkspaceBackup,prepareWorkspaceRestore,commitWorkspaceRestore} from '../src/main/backup.ts';
import {readCandidateFiles} from '../src/main/image-generation/candidate.ts';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP0cAAAAASUVORK5CYII=','base64');
function fixture(t:test.TestContext){mkdirSync(resolve('.test-data'),{recursive:true});const root=mkdtempSync(resolve('.test-data/candidate-backup-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const source=join(root,'source'),target=join(root,'target');for(const path of [source,target]){const s=new WorkspaceStore(path);s.createProduct();s.close();}return{root,source,target,file:join(root,'copy.htcbackup'),pass:'candidate backup fixture passphrase'};}
function candidate(root:string,id=randomUUID(),data=png){const folder=join(root,'image-generation/candidates',id);mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'image.png'),data);writeFileSync(join(folder,'preview.png'),png);writeFileSync(join(folder,'candidate.json'),JSON.stringify({id,provider:'openai',model:'gpt-image-2.5-sunburst',mode:'generate',productId:randomUUID(),productRevision:1,createdAt:new Date().toISOString(),requestId:null,sourceAssets:[],reviewState:'unreviewed',mimeType:'image/png',width:1,height:1,byteSize:data.length,sha256:createHash('sha256').update(data).digest('hex')}));return id;}
test('backup preserves paid candidates and restoring an old copy retains newer local candidates',async t=>{
 const f=fixture(t),old=candidate(f.source),newer=candidate(f.target);await createWorkspaceBackup(f.source,f.file,f.pass);
 const prepared=await prepareWorkspaceRestore(f.target,f.file,f.pass);await commitWorkspaceRestore(f.target,prepared);
 for(const id of [old,newer])assert.deepEqual((await readCandidateFiles(f.target,id)).bytes,png);
 assert.equal(existsSync(join(f.target,'.restore-journal.json')),false);
});
test('candidate identity conflicts refuse old restore instead of overwriting a paid image',async t=>{
 const f=fixture(t),id=candidate(f.source);const changed=Buffer.concat([png,Buffer.from('different')]);candidate(f.target,id,changed);
 await createWorkspaceBackup(f.source,f.file,f.pass);await assert.rejects(()=>prepareWorkspaceRestore(f.target,f.file,f.pass),/冲突/);
 assert.deepEqual(readFileSync(join(f.target,'image-generation/candidates',id,'image.png')),changed);
});
test('candidate installation rollback preserves both old images and unrelated generation files',async t=>{
 const f=fixture(t),incoming=candidate(f.source),prior=candidate(f.target);writeFileSync(join(f.target,'image-generation','private-sentinel'),'keep');await createWorkspaceBackup(f.source,f.file,f.pass);
 const prepared=await prepareWorkspaceRestore(f.target,f.file,f.pass);
 await assert.rejects(()=>commitWorkspaceRestore(f.target,prepared,point=>{if(point==='assets-installed')throw new Error('crash fixture');}),/crash fixture/);
 assert.deepEqual((await readCandidateFiles(f.target,prior)).bytes,png);assert.equal(existsSync(join(f.target,'image-generation/candidates',incoming)),false);assert.equal(readFileSync(join(f.target,'image-generation/private-sentinel'),'utf8'),'keep');
});

test('a candidate injected after preparation is not accepted as authenticated history',async t=>{
 const f=fixture(t);candidate(f.source);await createWorkspaceBackup(f.source,f.file,f.pass);const prepared=await prepareWorkspaceRestore(f.target,f.file,f.pass);candidate(prepared.stagingDirectory);
 await assert.rejects(()=>commitWorkspaceRestore(f.target,prepared),/未认证/);
});

test('restoring an older backup retains newer candidate pins and never shortens their promise',async t=>{
 const f=fixture(t);await createWorkspaceBackup(f.source,f.file,f.pass);const id=candidate(f.target),now=new Date(),pinId=randomUUID();
 const pin={id:pinId,version:1,operationId:randomUUID(),purpose:'candidate-review',state:'READY',url:null as string|null,createdAt:now.toISOString(),retainedUntil:new Date(now.getTime()+96*3600_000).toISOString(),releasedAt:null,attempts:1,assetId:id,sha256:createHash('sha256').update(png).digest('hex'),sourceKind:'candidate',sourceVersion:`candidate:${id}`,originalPath:`image-generation/candidates/${id}/image.png`,byteSize:png.length,mimeType:'image/png'};pin.url=`https://images.example.test/references/${pin.sha256}.png`;
 const db=openDatabase(f.target);db.prepare('INSERT INTO image_reference_pins VALUES(?,?)').run(pinId,JSON.stringify(pin));db.close();
 const prepared=await prepareWorkspaceRestore(f.target,f.file,f.pass);await commitWorkspaceRestore(f.target,prepared);
 const restored=openDatabase(f.target);try{assert.deepEqual(referencePinHistory(restored),[pin]);assert.equal(referencePinRetentionOwner.protects(restored,pin.originalPath,new Date(now.getTime()+10*86400_000)),true);}finally{restored.close();}
 assert.deepEqual((await readCandidateFiles(f.target,id)).bytes,png);
});

test('a pin cannot authenticate candidate bytes belonging to another hash',async t=>{
 const f=fixture(t),id=candidate(f.source),now=new Date(),hash='a'.repeat(64),pin={id:randomUUID(),version:1,operationId:randomUUID(),purpose:'candidate-review',state:'READY',url:`https://images.example.test/references/${hash}.png`,createdAt:now.toISOString(),retainedUntil:new Date(now.getTime()+72*3600_000).toISOString(),releasedAt:null,attempts:1,assetId:id,sha256:hash,sourceKind:'candidate',sourceVersion:`candidate:${id}`,originalPath:`image-generation/candidates/${id}/image.png`,byteSize:png.length,mimeType:'image/png'};
 const db=openDatabase(f.source);db.prepare('INSERT INTO image_reference_pins VALUES(?,?)').run(pin.id,JSON.stringify(pin));db.close();await assert.rejects(()=>createWorkspaceBackup(f.source,f.file,f.pass),/版本不一致/);
});
