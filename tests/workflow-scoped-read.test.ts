import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {workflowRuns} from '../src/main/image-workflow/records.ts';

function run(draftId:string){const now=new Date().toISOString();return {id:randomUUID(),draftId,productId:randomUUID(),productRevision:1,variantId:randomUUID(),sku:'SKU',status:'RUNNING',stage:'content',attempt:0,maxAttempts:2,contextSha256:null,draftSha256:null,referenceAssets:[],planResultIds:[],candidateIds:[],ocrResultIds:[],reviewResultIds:[],approvedAssetId:null,approvedSha256:null,createdAt:now,updatedAt:now,error:null};}
test('draft history validates only matching rows in newest-first order; global scan still rejects unrelated corruption',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE image_workflow_runs(id TEXT PRIMARY KEY,record_json TEXT NOT NULL)');
 const wanted=randomUUID(),old=run(wanted),latest=run(wanted),other=run(randomUUID());const put=db.prepare('INSERT INTO image_workflow_runs VALUES(?,?)');
 put.run(old.id,JSON.stringify(old));put.run(other.id,JSON.stringify({...other,attempt:99}));put.run(latest.id,JSON.stringify(latest));
 assert.deepEqual(workflowRuns(db,wanted),[latest,old]);assert.deepEqual(workflowRuns(db,randomUUID()),[]);assert.throws(()=>workflowRuns(db));
 db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(JSON.stringify({...latest,id:randomUUID()}),latest.id);
 assert.throws(()=>workflowRuns(db,wanted),/身份/);
});
