import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AutomaticWorkBatch } from '../../shared/automatic-work-batches.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { transaction } from '../application/transaction.ts';
export const WORK_BATCH_TABLES={automatic_work_batches:['id','record_json']};
const now=()=>new Date().toISOString();
export function beijingBatchDate(value:unknown):string|null {
  if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))return null;
  const date=new Date(Date.parse(value)+8*60*60*1000);return Number.isFinite(date.getTime())?date.toISOString().slice(0,10):null;
}
const batchName=(date:string|null,sequence:number)=>date?`${date} · 第${sequence}批`:`历史批次·日期未知 · 第${sequence}批`;
function validIds(value:unknown):value is string[]{return Array.isArray(value)&&value.every(id=>typeof id==='string'&&id.length>0&&id.length<=200)&&new Set(value).size===value.length;}
export function validateWorkBatch(raw:unknown):AutomaticWorkBatch{
  const b=raw as AutomaticWorkBatch;
  const keys=['id','name','date','sequence','createdAt','archivedAt','productIds','taskIds'];
  if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).length!==keys.length||keys.some(key=>!Object.hasOwn(b,key))||typeof b.id!=='string'||!b.id||b.id.length>200||!Number.isSafeInteger(b.sequence)||b.sequence<1||!validIds(b.productIds)||!validIds(b.taskIds)
    ||(b.createdAt!==null&&!beijingBatchDate(b.createdAt))||b.date!==beijingBatchDate(b.createdAt)||(b.archivedAt!==null&&!beijingBatchDate(b.archivedAt))||b.name!==batchName(b.date,b.sequence))throw new UserFacingError('工作批次记录无效');
  return b;
}
export function listWorkBatches(db:DatabaseSync):AutomaticWorkBatch[]{return db.prepare('SELECT id,record_json FROM automatic_work_batches ORDER BY rowid DESC').all().map(row=>{const b=validateWorkBatch(JSON.parse(String(row.record_json)));if(b.id!==row.id)throw new UserFacingError('批次身份不一致');return b;}).sort((a,b)=>Number(Boolean(a.archivedAt))-Number(Boolean(b.archivedAt))||(b.date??'').localeCompare(a.date??'')||b.sequence-a.sequence||a.id.localeCompare(b.id));}
export function assertWorkBatches(db:DatabaseSync):void{
  const batches=listWorkBatches(db),dates=new Set<string>(),tasks=new Set<string>();
  const saved=new Map(db.prepare('SELECT id,record_json FROM automatic_listing_tasks').all().map(row=>[String(row.id),JSON.parse(String(row.record_json))]));
  if(batches.filter(b=>!b.archivedAt).length!==1)throw new UserFacingError('当前批次记录不唯一');
  for(const b of batches){const key=`${b.date}:${b.sequence}`;if(dates.has(key))throw new UserFacingError('批次日期序号重复');dates.add(key);for(const id of b.taskIds){const task=saved.get(id);if(!task)throw new UserFacingError('批次引用的原任务不存在');if(!Array.isArray(task.items)||task.items.some((item:{productId:string})=>!b.productIds.includes(item.productId)))throw new UserFacingError('原任务商品与批次成员不一致');if(tasks.has(id))throw new UserFacingError('原任务被重复绑定批次');tasks.add(id);}}
  if([...saved.keys()].some(id=>!tasks.has(id)))throw new UserFacingError('原任务缺少工作批次归属');
}

function saveWorkBatch(db:DatabaseSync,b:AutomaticWorkBatch):void{
  validateWorkBatch(b);db.prepare('INSERT INTO automatic_work_batches(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(b.id,JSON.stringify(b));
}
export function currentWorkBatch(db:DatabaseSync,expectedId?:string):AutomaticWorkBatch{
  const batch=listWorkBatches(db).find(b=>!b.archivedAt);if(!batch||expectedId!==undefined&&batch.id!==expectedId)throw new UserFacingError('当前批次已变化，请刷新后重试');return batch;
}
function createWorkBatch(db:DatabaseSync,createdAt:string|null,id:string=randomUUID(),archivedAt:string|null=null):AutomaticWorkBatch{
  const date=beijingBatchDate(createdAt),sequence=Math.max(0,...listWorkBatches(db).filter(b=>b.date===date).map(b=>b.sequence))+1;
  const batch:AutomaticWorkBatch={id,name:batchName(date,sequence),date,sequence,createdAt,archivedAt,productIds:[],taskIds:[]};saveWorkBatch(db,batch);return batch;
}
/** Migration only: original task timestamps/identities remain untouched. */
export function initializeWorkBatches(db:DatabaseSync,at=now()):void{
  db.exec('CREATE TABLE automatic_work_batches(id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL)');
  const tasks=db.prepare('SELECT id,record_json FROM automatic_listing_tasks ORDER BY id').all().map(row=>({id:String(row.id),task:JSON.parse(String(row.record_json))}));
  tasks.sort((a,b)=>(beijingBatchDate(a.task.createdAt)?Date.parse(a.task.createdAt):Infinity)-(beijingBatchDate(b.task.createdAt)?Date.parse(b.task.createdAt):Infinity)||a.id.localeCompare(b.id));
  for(const {id,task} of tasks){const batch=createWorkBatch(db,beijingBatchDate(task.createdAt)?task.createdAt:null,`legacy-${id}`,at);batch.taskIds=[id];batch.productIds=[...new Set<string>((task.items??[]).map((item:{productId:string})=>item.productId))];saveWorkBatch(db,batch);}
  const current=createWorkBatch(db,at);current.productIds=db.prepare("SELECT product_id FROM product_workspaces WHERE lane='automatic' ORDER BY product_id").all().map(r=>String(r.product_id));saveWorkBatch(db,current);assertWorkBatches(db);
}
export function addWorkBatchProducts(db:DatabaseSync,id:string,productIds:string[]):void{
  transaction(db,()=>{const batch=currentWorkBatch(db,id);batch.productIds=[...new Set([...batch.productIds,...productIds])];saveWorkBatch(db,batch);});
}
export function bindWorkBatchTask(db:DatabaseSync,id:string,taskId:string):void{
  transaction(db,()=>{const batch=currentWorkBatch(db,id);if(listWorkBatches(db).some(b=>b.id!==id&&b.taskIds.includes(taskId)))throw new UserFacingError('任务必须继续原批次');batch.taskIds=[...new Set([...batch.taskIds,taskId])];saveWorkBatch(db,batch);});
}
export function archiveWorkBatch(db:DatabaseSync,id:string,at=now()):AutomaticWorkBatch{
  return transaction(db,()=>{const batch=currentWorkBatch(db,id);batch.archivedAt=at;saveWorkBatch(db,batch);return createWorkBatch(db,at);});
}
/** Restore cannot roll back batch membership, sequence high-water marks or current identity. */
export function retainWorkBatches(current:DatabaseSync,snapshot:DatabaseSync,migratedSnapshot=false):void{
  if(!current.prepare("SELECT 1 FROM sqlite_master WHERE name='automatic_work_batches' AND type='table'").get())return;
  transaction(snapshot,()=>{
    const live=listWorkBatches(current),liveCurrent=currentWorkBatch(current),at=now();
    const savedTasks=new Set(snapshot.prepare('SELECT id FROM automatic_listing_tasks').all().map(row=>String(row.id)));
    if(live.some(batch=>batch.taskIds.some(id=>!savedTasks.has(id))))throw new UserFacingError('备份缺少后续批次原任务身份，无法安全恢复，请选更新备份/保留当前工作区');
    // Task IDs alone are insufficient when explicit adaptation added another SKU.
    for(const row of current.prepare('SELECT id,record_json FROM automatic_listing_tasks').all()){
      if(!live.some(batch=>batch.taskIds.includes(String(row.id))))continue;
      const saved=snapshot.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(row.id);
      const task=JSON.parse(String(row.record_json)),old=JSON.parse(String(saved!.record_json));
      const keys=['key','productId','variantId','sku'];
      if(!Array.isArray(task.items)||!Array.isArray(old.items)||task.items.some((item:Record<string,unknown>)=>!old.items.some((prior:Record<string,unknown>)=>keys.every(key=>item[key]===prior[key]))))throw new UserFacingError('备份缺少后续批次原任务的 SKU 身份，无法安全恢复，请选更新备份/保留当前工作区');
    }
    if(migratedSnapshot){const temporary=currentWorkBatch(snapshot);if(temporary.taskIds.length)throw new UserFacingError('恢复迁移临时批次已有任务，不能替换');snapshot.prepare('DELETE FROM automatic_work_batches WHERE id=?').run(temporary.id);}
    const saved=listWorkBatches(snapshot);
    for(const b of saved)if(!b.archivedAt&&b.id!==liveCurrent.id){b.archivedAt=at;saveWorkBatch(snapshot,b);}
    for(const b of live){const old=saved.find(s=>s.id===b.id);if(old&&(old.date!==b.date||old.sequence!==b.sequence))throw new UserFacingError('恢复批次身份冲突');saveWorkBatch(snapshot,b);}
    assertWorkBatches(snapshot);
  });
}
