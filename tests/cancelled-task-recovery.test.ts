import test from 'node:test';
import assert from 'node:assert/strict';
import { planCancelledTaskRecovery } from '../src/main/automatic-listing/cancelled-recovery.ts';

const idle={workerActive:false,confirming:false,archiving:false,preparing:false};
function fixture(){
  return {id:'synthetic-cancelled-task',revision:1953,status:'CANCELLED' as const,error:'原请求结果未知',currentRound:{roundId:'original-round',mode:'from-start',fees:{reportedUsdMicros:42}},items:[{key:'original-sku',sku:'SYNTHETIC-32',status:'FAILED',stage:'DRAFT',outcome:{kind:'UNKNOWN'},executionTaskIds:['original-child'],repairAttempts:4,aiCalls:7,sourceStamp:'original-source'}]};
}
test('cancel recovery changes only the status header and leaves all original body and fees untouched',()=>{
  const task=fixture(),before=structuredClone(task),input={taskId:task.id,expectedRevision:task.revision};
  const plan=planCancelledTaskRecovery(task,input,idle);
  assert.deepEqual(plan.patch,{status:'PAUSED'});assert.deepEqual(task,before);
  const next={...task,...plan.patch};assert.equal(next.items,task.items);assert.equal(next.currentRound,task.currentRound);assert.equal(next.error,task.error);
  assert.deepEqual(plan.audit.detail,{version:1,taskId:task.id,fromRevision:1953,toRevision:1954,fromStatus:'CANCELLED',toStatus:'PAUSED'});
});
test('wrong task, stale revision and non-cancelled states cannot produce a recovery patch',()=>{
  const task=fixture();
  assert.throws(()=>planCancelledTaskRecovery(task,{taskId:'other-task',expectedRevision:1953},idle),/任务版本/);
  assert.throws(()=>planCancelledTaskRecovery(task,{taskId:task.id,expectedRevision:1952},idle),/任务版本/);
  for(const status of ['PAUSED','NEEDS_ATTENTION','RUNNING','COMPLETED'] as const)
    assert.throws(()=>planCancelledTaskRecovery({...task,status},{taskId:task.id,expectedRevision:1953},idle),/已取消/);
});
test('active worker, pending confirmation, archive or preparation blocks local cancelled recovery',()=>{
  const task=fixture(),input={taskId:task.id,expectedRevision:1953};
  for(const key of Object.keys(idle) as (keyof typeof idle)[])
    assert.throws(()=>planCancelledTaskRecovery(task,input,{...idle,[key]:true}),/尚未结束/);
  assert.equal(task.status,'CANCELLED');assert.equal(task.revision,1953);
});
