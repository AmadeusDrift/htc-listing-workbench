import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { AutomaticSchemaRetry } from '../../shared/automatic-listing-contracts.ts';
import { record, identifier, text } from '../../shared/validation.ts';
import { selection } from '../amazon/context.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { transaction } from '../application/transaction.ts';
import { assertRecordTable } from '../storage/record-table.ts';

export const SCHEMA_OPERATION_TABLES={schema_fetch_operations:['id','record_json']};
const fail=():never=>{throw new UserFacingError('Schema 操作范围或预算历史无效');};
const date=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value))?value:fail();
const hash=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:fail();
export function validateSchemaRetry(raw:unknown):AutomaticSchemaRetry{
  const r=record(raw,'Schema 重试',['version','scope','selection','originalStage','firstFailureAt','dueAt','deadlineAt','usedDelayedRounds','state','reason']);
  if(Object.keys(r).length!==10||r.version!==1||r.reason!=='SCHEMA_TRANSIENT'||!['WAITING','IN_FLIGHT','SUCCEEDED','EXHAUSTED'].includes(String(r.state))
    ||!['SOURCES','CLASSIFY','DRAFT','IMAGES','PARENT','EXECUTION'].includes(String(r.originalStage))||!Number.isSafeInteger(r.usedDelayedRounds)||Number(r.usedDelayedRounds)<0||Number(r.usedDelayedRounds)>3)fail();
  const selected=record(r.selection,'Schema 选择',['targetId','productType','parentageLevel','requirements','locale']);if(Object.keys(selected).length!==5)fail();
  const value:AutomaticSchemaRetry={version:1,scope:hash(r.scope),selection:selection(selected),originalStage:r.originalStage as AutomaticSchemaRetry['originalStage'],firstFailureAt:date(r.firstFailureAt),dueAt:date(r.dueAt),deadlineAt:date(r.deadlineAt),usedDelayedRounds:Number(r.usedDelayedRounds),state:r.state as AutomaticSchemaRetry['state'],reason:'SCHEMA_TRANSIENT'};
  const first=Date.parse(value.firstFailureAt),due=Date.parse(value.dueAt),deadline=Date.parse(value.deadlineAt);
  if(deadline!==first+600_000||due<first||due>deadline||value.state==='IN_FLIGHT'&&!value.usedDelayedRounds)fail();
  return value;
}
interface SchemaOperation{version:1;id:string;taskId:string;rowKey:string;initialBudget:AutomaticSchemaRetry;budget:AutomaticSchemaRetry}
export function schemaOperationId(taskId:string,rowKey:string,scope:string):string{
  return createHash('sha256').update(JSON.stringify([identifier(taskId),text(rowKey,'Schema任务行',500,true),hash(scope)])).digest('hex');
}
function validateOperation(raw:unknown):SchemaOperation{
  const r=record(raw,'Schema操作',['version','id','taskId','rowKey','initialBudget','budget']);
  if(Object.keys(r).length!==6||r.version!==1)fail();
  const initialBudget=validateSchemaRetry(r.initialBudget),budget=validateSchemaRetry(r.budget),taskId=identifier(r.taskId),rowKey=text(r.rowKey,'Schema任务行',500,true);
  if(r.id!==schemaOperationId(taskId,rowKey,budget.scope)||initialBudget.scope!==budget.scope||initialBudget.firstFailureAt!==budget.firstFailureAt||initialBudget.deadlineAt!==budget.deadlineAt
    ||JSON.stringify(initialBudget.selection)!==JSON.stringify(budget.selection)||budget.usedDelayedRounds<initialBudget.usedDelayedRounds)fail();
  return{version:1,id:String(r.id),taskId,rowKey,initialBudget,budget};
}
export function readSchemaOperation(db:DatabaseSync,taskId:string,rowKey:string,scope:string):SchemaOperation|null{
  const id=schemaOperationId(taskId,rowKey,scope),row=db.prepare('SELECT record_json FROM schema_fetch_operations WHERE id=?').get(id);
  if(!row)return null;const value=validateOperation(JSON.parse(String(row.record_json)));if(value.id!==id)fail();return value;
}
/** M05 owns the authoritative budget. Task JSON is a compatibility/status projection. */
export function saveSchemaOperation(db:DatabaseSync,taskId:string,rowKey:string,input:AutomaticSchemaRetry):AutomaticSchemaRetry{
  return transaction(db,()=>{
    const next=validateSchemaRetry(input),prior=readSchemaOperation(db,taskId,rowKey,next.scope);
    if(prior&&(prior.budget.firstFailureAt!==next.firstFailureAt||prior.budget.deadlineAt!==next.deadlineAt||JSON.stringify(prior.budget.selection)!==JSON.stringify(next.selection)))fail();
    const budget=prior&&(prior.budget.usedDelayedRounds>next.usedDelayedRounds||prior.budget.state==='EXHAUSTED')?prior.budget:next;
    const value:SchemaOperation=prior?{...prior,budget}:{version:1,id:schemaOperationId(taskId,rowKey,next.scope),taskId,rowKey,initialBudget:structuredClone(next),budget};
    db.prepare('INSERT INTO schema_fetch_operations(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(value.id,JSON.stringify(value));
    return structuredClone(value.budget);
  });
}
export function initializeSchemaOperations(db:DatabaseSync):void{
  transaction(db,()=>{
    db.exec('CREATE TABLE IF NOT EXISTS schema_fetch_operations(id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL)');
    for(const row of db.prepare('SELECT id,record_json FROM automatic_listing_tasks').iterate()){
      const task=JSON.parse(String(row.record_json));if(task.id!==row.id||!Array.isArray(task.items))fail();
      for(const item of task.items)if(item.schemaRetry)saveSchemaOperation(db,task.id,item.key,item.schemaRetry);
    }
  });
}
export function restoreSchemaOperations(current:DatabaseSync,snapshot:DatabaseSync):void{
  revokeSchemaInFlight(snapshot);
  if(!current.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_fetch_operations' AND type='table'").get())return;
  for(const row of current.prepare('SELECT id,record_json FROM schema_fetch_operations').iterate()){
    const value=validateOperation(JSON.parse(String(row.record_json)));if(value.id!==row.id)fail();
    const prior=readSchemaOperation(snapshot,value.taskId,value.rowKey,value.budget.scope);
    const greatest=prior&&prior.budget.usedDelayedRounds>value.budget.usedDelayedRounds?prior.budget:value.budget;
    const budget:AutomaticSchemaRetry={...greatest,state:value.budget.state==='EXHAUSTED'||prior?.budget.state==='EXHAUSTED'?'EXHAUSTED':'WAITING'};
    if(!prior)snapshot.prepare('INSERT INTO schema_fetch_operations(id,record_json) VALUES(?,?)').run(value.id,JSON.stringify({...value,budget}));
    else saveSchemaOperation(snapshot,value.taskId,value.rowKey,budget);
  }
}
export function revokeSchemaInFlight(db:DatabaseSync):void{
  for(const row of db.prepare('SELECT id,record_json FROM schema_fetch_operations').iterate()){
    const value=validateOperation(JSON.parse(String(row.record_json)));if(value.id!==row.id)fail();
    if(value.budget.state==='IN_FLIGHT')saveSchemaOperation(db,value.taskId,value.rowKey,{...value.budget,state:'WAITING'});
  }
}
export function assertSchemaOperationHistory(db:DatabaseSync):void{
  if(Number(db.prepare('PRAGMA user_version').get()!.user_version)<24)return;
  assertRecordTable(db,'schema_fetch_operations');
  for(const row of db.prepare('SELECT id,record_json FROM schema_fetch_operations').iterate())if(validateOperation(JSON.parse(String(row.record_json))).id!==row.id)fail();
}
export function planSchemaAttempt(raw:AutomaticSchemaRetry,now:number):{kind:'waiting'|'exhausted'|'ready';budget:AutomaticSchemaRetry}{
  const budget=validateSchemaRetry(raw);
  if(budget.state!=='WAITING')return{kind:'waiting',budget};
  if(budget.usedDelayedRounds>=3||now>=Date.parse(budget.deadlineAt))return{kind:'exhausted',budget:{...budget,state:'EXHAUSTED'}};
  if(now<Date.parse(budget.dueAt))return{kind:'waiting',budget};
  budget.usedDelayedRounds++;budget.state='IN_FLIGHT';
  budget.dueAt=new Date(Math.min(Date.parse(budget.deadlineAt),now+([30_000,90_000,180_000][budget.usedDelayedRounds]??0))).toISOString();
  return{kind:'ready',budget};
}
export function reserveSchemaAttempt(db:DatabaseSync,taskId:string,rowKey:string,prior:AutomaticSchemaRetry,now:number){
  return transaction(db,()=>{
    const current=readSchemaOperation(db,taskId,rowKey,prior.scope)?.budget??saveSchemaOperation(db,taskId,rowKey,prior);
    const plan=planSchemaAttempt(current,now);
    if(plan.kind!=='waiting')saveSchemaOperation(db,taskId,rowKey,plan.budget);
    return plan;
  });
}
