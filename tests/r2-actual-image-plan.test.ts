import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,mkdirSync,mkdtempSync,copyFileSync,cpSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {parseImagePlanRecovery} from '../src/main/ai/image-validation.ts';
import {WorkspaceStore} from '../src/main/store.ts';
import {HostingService} from '../src/main/hosting/service.ts';
import {AiService} from '../src/main/ai/service.ts';
import {recordInvalidAiOutput} from '../src/main/ai/output-diagnostics.ts';
import type {ProductImageContext} from '../src/shared/image-ai-contracts.ts';
const base=resolve('../../detailed-investigation-20261012'),source=join(base,'source.sqlite');
test('R2 actual 65 retained raw response recovers offline while 92/71B/93C stay invalid',{skip:!existsSync(source)},async()=>{
 const db=new DatabaseSync(source,{readOnly:true}),diagnostics=JSON.parse(readFileSync(join(base,'diagnostics.json'),'utf8')).files;
 const calls=db.prepare('SELECT record_json FROM ai_calls').all().map(r=>JSON.parse(String(r.record_json))),runs=db.prepare('SELECT record_json FROM image_workflow_runs').all().map(r=>JSON.parse(String(r.record_json)));
 const contextFor=(call:any):ProductImageContext=>{const run=runs.find(r=>r.id===call.presentationContext.workflowId),index=call.presentationContext.slot;return index?{...run.imageContext,setPlan:run.setPlan,purpose:index===1?'main':'detail',slot:{index,total:7,provisional:true}}:run.imageContext;};
 for(const prefix of ['a6fea932','6994b9de','213ee20a']){const call=calls.find(c=>c.id.startsWith(prefix)),raw=diagnostics.find((d:any)=>d.callId===call.id).output;assert.throws(()=>parseImagePlanRecovery(raw,contextFor(call)),prefix);}
 const call=calls.find(c=>c.id.startsWith('bbe4a846')),diagnostic=diagnostics.find((d:any)=>d.callId===call.id),context=contextFor(call);assert.throws(()=>JSON.parse(diagnostic.output));assert.equal(parseImagePlanRecovery(diagnostic.output,context).kind,'image-plan');db.close();
 mkdirSync(resolve('.test-data'),{recursive:true});const directory=mkdtempSync(resolve('.test-data/r2-actual-'));
 copyFileSync(source,join(directory,'red.sqlite'));cpSync(resolve('../../next-batch-20261012/offline-actual-v3/assets'),join(directory,'assets'),{recursive:true});
 let requests=0;const storage={isEncryptionAvailable:()=>false,encryptString:()=>{throw Error('Offline no secret');},decryptString:()=>{throw Error('Offline no secret');}},store=new WorkspaceStore(directory),hosting=new HostingService(directory,store,storage),ai=new AiService(directory,store,hosting,storage,{fetch:async()=>{requests++;throw Error('Offline only');}}),verify=new DatabaseSync(join(directory,'red.sqlite'));
 try{
  recordInvalidAiOutput(directory,{call,operation:'image-plan',createdAt:call.finishedAt,rejectionStage:diagnostic.rejectionStage,rejectionReason:diagnostic.rejectionReason,output:diagnostic.output});
  const tables=['ai_calls','ai_results','ai_usage_ledger','image_workflow_runs','image_generation_requests','image_generation_candidates'].filter(name=>verify.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const before=new Map(tables.map(name=>[name,verify.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
  const result=await ai.recoverImagePlan(call.id,context,()=>{});assert.ok(result);assert.equal(result.imagePlanRecovery?.parserVersion,'image-plan-recovery/v2');assert.equal(result.imagePlanRecovery.rawOutput,diagnostic.output);assert.equal((await ai.recoverImagePlan(call.id,context,()=>{}))?.id,result.id);assert.equal(requests,0);
  for(const name of tables){let rows=verify.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();if(name==='ai_results')rows=rows.filter(r=>r.id!==result.id);assert.deepEqual(rows,before.get(name),name);}
 }finally{verify.close();await ai.close();await hosting.close();store.close();rmSync(directory,{recursive:true,force:true});}
});
