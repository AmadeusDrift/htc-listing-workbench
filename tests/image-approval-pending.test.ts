import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import type {ImageWorkflowRun} from '../src/shared/image-workflow-contracts.ts';
import {assertApprovalReviewsResolved,ImageReviewPendingError} from '../src/main/image-workflow/approval-pending.ts';

test('legacy review identity gap remains pending without inventing a sent call or a NOT_SENT proof',()=>{
 const db=new DatabaseSync(':memory:'),run={id:randomUUID(),recheckedFromRunId:randomUUID(),draftId:randomUUID(),productId:randomUUID(),variantId:randomUUID(),sku:'LEGACY-S05',status:'FAILED',stage:'ip-check',activeSlot:1,slots:[{index:1,contextSha256:'a'.repeat(64),attempts:[{number:1,candidateId:randomUUID(),ipReviewResultId:null}]}]} as ImageWorkflowRun;
 try{
  assert.throws(()=>assertApprovalReviewsResolved(db,'unused-memory-fixture',run,[run],[]),(error:unknown)=>error instanceof ImageReviewPendingError&&error.workflowId===run.id&&error.slot===1&&error.step==='risk'&&error.callId===undefined&&error.certainty===undefined&&error.diagnosticReason==='IMAGE_REVIEW_IDENTITY_MISSING'&&/缺少原请求身份，无法证明未发送/.test(error.message));
  // A local content-stage failure without an attempted review is not an unknown review.
  assert.doesNotThrow(()=>assertApprovalReviewsResolved(db,'unused-memory-fixture',{...run,stage:'content'},[{...run,stage:'content'}],[]));
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()?.n,0);
 }finally{db.close();}
});
