import { parentPort,workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { archiveWorkBatch } from '../../src/main/automatic-listing/work-batches.ts';
const db=new DatabaseSync(workerData.path);db.exec('PRAGMA busy_timeout=5000');
let result;try{result={ok:true,batch:archiveWorkBatch(db,workerData.id)};}catch(error){result={ok:false,error:String(error)};}finally{db.close();}parentPort.postMessage(result);
