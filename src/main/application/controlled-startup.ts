import {DatabaseSync} from 'node:sqlite';
import {existsSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {validateImageWriteOperation} from '../image-versions/recovery.ts';
import {UserFacingError} from '../../shared/errors.ts';

/** Run before migrations, restore recovery, snapshots or any recovering service.
 * UNKNOWN history and unleased PENDING usage are liabilities, not evidence that
 * another process is currently dispatching. Their owners must remain read-only.
 */
export function preflightControlledAcceptance(directory:string):void{
 if(existsSync(join(directory,'.restore-journal.json')))throw new UserFacingError('受控验收不能进入尚未安全完成的备份恢复，请先核对原恢复记录');
 const file=join(directory,'red.sqlite');if(!existsSync(file))return;
 const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new UserFacingError('受控验收工作区数据库路径不可信');
 const db=new DatabaseSync(file,{readOnly:true});
 try{
  db.exec('PRAGMA query_only=ON');const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>String(r.name)));
  const records=(table:string)=>tables.has(table)?db.prepare(`SELECT record_json FROM ${table} WHERE record_json IS NOT NULL`).all().map(r=>{const raw=JSON.parse(String(r.record_json));if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new UserFacingError('受控验收在途记录格式无效');return raw as Record<string,unknown>;}):[];
  const inflight=(table:string,predicate:(r:Record<string,unknown>)=>boolean)=>{if(records(table).some(predicate))throw new UserFacingError(`受控验收发现${table}仍有原在途身份；请等待安全切换，未暂停或改写旧任务`);};
  inflight('automatic_listing_tasks',r=>['RUNNING','QUEUED'].includes(String(r.status)));
  inflight('execution_tasks',r=>['RUNNING','QUEUED'].includes(String(r.status)));
  inflight('ai_calls',r=>r.status==='RUNNING');
  inflight('hosting_uploads',r=>['UPLOADING','VERIFYING'].includes(String(r.status)));
  inflight('item_labels',r=>r.requestPending===true||r.status==='REQUESTING'||r.current===true&&r.status==='DOWNLOADING');
  inflight('ai_spend_reservations',r=>r.state==='DISPATCH_ATTEMPTED');
  inflight('miaoshou_sync_runs',r=>r.status==='running');
  inflight('listing_corrections',r=>r.state==='SENDING');
  inflight('listing_drafts',r=>(r.draft as Record<string,unknown>|undefined)?.state==='SUBMITTING');
  for(const r of records('image_write_operations')){const op=validateImageWriteOperation(r);if(op.state==='WRITING')throw new UserFacingError('受控验收发现本地图片仍有原在途写入身份；请先安全核对');}
  inflight('image_workflow_runs',r=>r.status==='RUNNING');
  inflight('ai_batches',r=>r.state==='submitting'||r.state==='waiting'&&typeof r.remoteBatchId==='string'&&['validating','in_progress','finalizing','cancelling'].includes(String(r.remoteStatus)));
  if(tables.has('amazon_write_locks')&&db.prepare("SELECT 1 FROM amazon_write_locks WHERE state IN ('SUBMITTING','SENDING') LIMIT 1").get())throw new UserFacingError('受控验收发现Amazon仍有原在途写入身份；请等待安全切换');
 }finally{db.close();}
}
