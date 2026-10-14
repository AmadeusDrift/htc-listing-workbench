// Controller-owned Node foundation worker. Production checkpoints remain owner work.
import assert from 'node:assert/strict';
const guard=(globalThis as typeof globalThis & {__s10Guard?:{installedBeforeMain:boolean}}).__s10Guard;
assert.ok(guard?.installedBeforeMain,'S10 guard must precede worker');
const nonce=process.env.S10_WORKER_NONCE;
assert.ok(nonce&&process.send,'S10 controller IPC required');
process.send({nonce,pid:process.pid,executable:process.execPath,dataRoot:process.env.RED_DATA_DIR,sourceCommit:process.env.S10_SOURCE_COMMIT});
if(process.argv[2]==='hold'){
  const timer=setInterval(()=>{},1000);
  process.on('message',message=>{if((message as {s10Stop?:string}).s10Stop===nonce){clearInterval(timer);process.disconnect?.();}});
}else{assert.equal(process.argv[2],'foundation');process.disconnect?.();}
