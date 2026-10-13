import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fixture } from './fixtures/batch.ts';
import { createWorkspaceBackup,prepareWorkspaceRestore,commitWorkspaceRestore } from '../src/main/backup.ts';
import { openDatabase } from '../src/main/database.ts';
import { BatchService } from '../src/main/ai/batch/service.ts';
import { readProviderReceipt } from '../src/main/ai/receipts.ts';

for(const known of [false,true])test(`A49 old encrypted backup retains ${known?'remote ID and receipt':'unknown create identity'} without duplicate POST`,async t=>{
  let posts=0;
  const f=fixture(t,async()=>{posts++;if(!known)throw Error('lost create response');return Response.json({id:'batch_restore',model:'openai/gpt-6-luna',endpoint:'/v1/chat/completions',status:'validating',results:null},{status:202});});
  const file=join(f.directory,'before.htcbackup'),pass='synthetic batch recovery password';await createWorkspaceBackup(f.directory,file,pass);
  const operation=f.operation(),[batch]=f.service.prepare([operation]);await f.service.submit(batch.id).catch(()=>{});
  const prepared=await prepareWorkspaceRestore(f.directory,file,pass);f.close();await commitWorkspaceRestore(f.directory,prepared);
  const db=openDatabase(f.directory),service=new BatchService(db,f.directory,{fetch:async()=>{posts++;throw Error('unexpected POST');},credential:()=>({apiKey:'batch-fixture-private-key',scope:operation.credentialScope})});
  try{
    const saved=service.get(batch.id);assert.equal(saved.locallyStopped,true);assert.equal(saved.remoteBatchId,known?'batch_restore':null);
    if(known){await service.submit(batch.id);assert.ok(await readProviderReceipt(db,f.directory,batch.id));const receipt=db.prepare('SELECT record_json FROM ai_provider_receipts LIMIT 1').get()!;const path=JSON.parse(String(receipt.record_json)).relativePath;assert.ok(readFileSync(join(f.directory,path)).length);}
    else await assert.rejects(service.submit(batch.id),/未知/);
    assert.equal(posts,1);assert.throws(()=>service.prepare([{...operation,inputFingerprint:'d'.repeat(64)}]),/已有/);
    await createWorkspaceBackup(f.directory,join(f.directory,'again.htcbackup'),pass);
  }finally{db.close();}
});

test('pause during create keeps a late remote ID but cannot apply a result',async t=>{
  let release!:(r:Response)=>void,started!:()=>void;const sent=new Promise<void>(r=>{started=r;});
  const f=fixture(t,async()=>{started();return new Promise<Response>(r=>{release=r;});}),[batch]=f.service.prepare([f.operation()]),controller=new AbortController();
  const pending=f.service.submit(batch.id,controller.signal);await sent;f.service.stopLocally(batch.id);controller.abort();
  release(Response.json({id:'batch_late',model:batch.model,endpoint:'/v1/chat/completions',status:'validating',results:null},{status:202}));await assert.rejects(pending);
  assert.equal(f.service.get(batch.id).remoteBatchId,'batch_late');assert.equal(f.service.get(batch.id).locallyStopped,true);
});

test('result conflicts retain raw responses without overwriting an already collected item',async t=>{
  let raw:any;const f=fixture(t,async(_url,init)=>Response.json(init?.method==='POST'?{id:'batch_conflict',model:'openai/gpt-6-luna',endpoint:'/v1/chat/completions',status:'validating',results:null}:raw,{status:init?.method==='POST'?202:200}));
  const [batch]=f.service.prepare([f.operation()]);await f.service.submit(batch.id);const item=f.service.items(batch.id)[0],result={custom_id:item.customId,response:{status_code:200,request_id:'req_one',body:{text:'original'}},error:null};
  raw={id:'batch_conflict',model:batch.model,endpoint:'/v1/chat/completions',status:'completed',results:[result]};await f.service.reconcile(batch.id);const before=f.service.items(batch.id)[0];
  raw.results=[{...result,response:{...result.response,body:{text:'changed'}}}];await assert.rejects(f.service.reconcile(batch.id),/变化|覆盖/);
  assert.deepEqual(f.service.items(batch.id)[0],before);assert.ok(f.service.get(batch.id).receiptIds.length>=3);
  let invoked=false;assert.throws(()=>f.service.adopt(item.id,{inputFingerprint:item.inputFingerprint,authorize:()=>true,apply:(async()=>{invoked=true;return 'invalid';}) as any}),/同步/);assert.equal(invoked,false);
  f.db.exec('CREATE TABLE fixture_adoption(id TEXT PRIMARY KEY)');
  assert.throws(()=>f.service.adopt(item.id,{inputFingerprint:item.inputFingerprint,authorize:()=>true,apply:(_item,db)=>{db.prepare('INSERT INTO fixture_adoption VALUES(?)').run('rollback');throw Error('owner failure');}}),/owner failure/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM fixture_adoption').get()!.n,0);assert.equal(f.service.items(batch.id)[0].adoption,null);
});
for(const backupBefore of [true,false])test(`pointer-only paid response survives ${backupBefore?'older backup merge':'new backup capture'} and never rePOSTs`,async t=>{
  let posts=0;const f=fixture(t,async()=>{posts++;return Response.json({id:'batch_orphan',model:'openai/gpt-6-luna',endpoint:'/v1/chat/completions',status:'validating',results:null},{status:202});});
  const file=join(f.directory,'pointer.htcbackup'),pass='orphan synthetic batch backup';if(backupBefore)await createWorkspaceBackup(f.directory,file,pass);
  const operation=f.operation(),[batch]=f.service.prepare([operation]);await f.service.submit(batch.id);
  f.db.exec('DELETE FROM ai_provider_receipts');const interrupted={...f.service.get(batch.id),receiptIds:[],remoteBatchId:null,remoteStatus:null,state:'submission_unknown'};f.db.prepare('UPDATE ai_batches SET record_json=? WHERE id=?').run(JSON.stringify(interrupted),batch.id);
  if(!backupBefore)await createWorkspaceBackup(f.directory,file,pass);
  const prepared=await prepareWorkspaceRestore(f.directory,file,pass);f.close();await commitWorkspaceRestore(f.directory,prepared);
  const db=openDatabase(f.directory),service=new BatchService(db,f.directory,{fetch:async()=>{posts++;throw Error('no retry');},credential:()=>({apiKey:'batch-fixture-private-key',scope:operation.credentialScope})});
  try{assert.ok(await readProviderReceipt(db,f.directory,batch.id));await service.reconcile(batch.id);assert.equal(service.get(batch.id).remoteBatchId,'batch_orphan');assert.equal(posts,1);}finally{db.close();}
});
