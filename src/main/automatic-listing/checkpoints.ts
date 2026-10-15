import type { DatabaseSync } from 'node:sqlite';
import type { AutomaticListingTask, AutomaticListingItem } from '../../shared/automatic-listing-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { validateAutomaticListingTask, validateAutomaticTaskCheckpoint } from './records.ts';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const header=(task:AutomaticListingTask)=>{
  const {items:_items,revision:_revision,updatedAt:_updated,status:_status,error:_error,resumeScope:_resumeScope,...scope}=task;
  return JSON.stringify(scope);
};
export interface TaskCheckpointChange {
  full:boolean;
  items:AutomaticListingItem[];
  priorStages:Map<string,{stage:string;status:string}>;
  serializedItems:string[];
  indices:number[];
  sql:string;
  parameters:(string|number)[];
}
/** Keeps the legacy complete JSON readable by every guard and backup. Partial JSON
 * patches avoid serializing unrelated SKU payloads; SQLite still owns one task row.
 * Physical per-SKU storage needs a separate, coordinated reader/backup migration. */
export class AutomaticTaskCheckpoints {
  private previous=new Map<string,AutomaticListingTask>();
  private stamps=new Map<string,Map<string,{json:string;stamp:string}>>();
  remember(task:AutomaticListingTask,change?:TaskCheckpointChange):void{
    const prior=this.previous.get(task.id),full=!prior||!change||change.full;
    const stamps=full?new Map():this.stamps.get(task.id)!;
    const {items:_items,...metadata}=task;
    const items=full?new Array<AutomaticListingItem>(task.items.length):prior.items.slice();
    const indices=full?task.items.map((_,index)=>index):change!.indices;
    for(const [offset,index] of indices.entries()){
      const item=task.items[index],json=change?.serializedItems[offset]??JSON.stringify(item);
      if(stamps.get(item.key)?.json!==json)stamps.set(item.key,{json,stamp:createHash('sha256').update(json).digest('hex')});
      items[index]=structuredClone(item);
    }
    this.stamps.set(task.id,stamps);this.previous.set(task.id,{...structuredClone(metadata),items});
  }
  itemStamp(id:string,key:string):string|null{return this.stamps.get(id)?.get(key)?.stamp??null;}
  revision(id:string):number|undefined{return this.previous.get(id)?.revision;}
  forget(id:string):void{this.previous.delete(id);}
  matches(task:AutomaticListingTask):boolean{const before=this.previous.get(task.id);return !!before&&isDeepStrictEqual(before,task);}
  persistedIndices(task:AutomaticListingTask,keys:readonly string[]|undefined):number[]|null{
    const prior=this.previous.get(task.id);
    if(keys===undefined||!prior||prior.revision!==task.revision||header(prior)!==header(task)
      ||prior.items.length!==task.items.length||prior.items.some((row,index)=>row.key!==task.items[index].key)
      ||['COMPLETED','CANCELLED'].includes(task.status))return null;
    const selected=new Set(keys),indices=prior.items.flatMap((row,index)=>selected.has(row.key)?[index]:[]);
    return indices.length===selected.size&&indices.length<=100?indices:null;
  }
  matchesPersistedParts(id:string,metadata:unknown,indices:readonly number[],items:unknown[]):boolean{
    const prior=this.previous.get(id);if(!prior)return false;
    const {items:_items,...before}=prior;
    return isDeepStrictEqual(before,metadata)&&indices.every((index,offset)=>isDeepStrictEqual(prior.items[index],items[offset]));
  }
  prepare(task:AutomaticListingTask, forceFull=false, evidenceKeys:string[]=[],beforeValidate?:(items:AutomaticListingItem[])=>void, changedKeys?:readonly string[]):TaskCheckpointChange{
    const prior=this.previous.get(task.id);
    let full=forceFull||!prior||prior.revision!==task.revision-1||header(prior)!==header(task)
      ||prior.items.length!==task.items.length||prior.items.some((row,index)=>row.key!==task.items[index].key)
      ||['COMPLETED','CANCELLED'].includes(task.status);
    // One comparison pass, then carry the changed set through validation, SQL,
    // diagnostics and cache update. Unchanged SKU payloads are never serialized
    // or cloned by the ordinary checkpoint path.
    const explicit=changedKeys===undefined?null:new Set([...changedKeys,...evidenceKeys]);
    if(explicit&&[...explicit].some(key=>!task.items.some(row=>row.key===key)))throw new UserFacingError('检查点 SKU 范围无效');
    let indices=task.items.flatMap((row,index)=>full||(explicit?explicit.has(row.key):evidenceKeys.includes(row.key)||!isDeepStrictEqual(row,prior!.items[index]))?[index]:[]);
    if(indices.length>100&&!full){full=true;indices=task.items.map((_,index)=>index);}
    const items=indices.map(index=>task.items[index]);beforeValidate?.(items);
    if(full)validateAutomaticListingTask(task);else validateAutomaticTaskCheckpoint(task,prior!,new Set(items.map(row=>row.key)));
    const priorStages=new Map(prior?.items.map(row=>[row.key,{stage:row.stage,status:row.status}]));
    const serializedItems=items.map(row=>JSON.stringify(row));
    const paths=indices.map(index=>`'$.items[${index}]',json(?)`);
    const scopePatch=task.resumeScope===undefined?'':",'$.resumeScope',json(?)";
    const patch=`json_set(record_json,'$.revision',?,'$.updatedAt',?,'$.status',?,'$.error',json(?)${paths.length?','+paths.join(','):''}${scopePatch})`;
    const sql=full?'UPDATE automatic_listing_tasks SET record_json=? WHERE id=? AND json_extract(record_json,\'$.revision\')=?'
      :`UPDATE automatic_listing_tasks SET record_json=${task.resumeScope===undefined?`json_remove(${patch},'$.resumeScope')`:patch} WHERE id=? AND json_extract(record_json,'$.revision')=?`;
    const parameters=full?[JSON.stringify(task)]:[task.revision,task.updatedAt,task.status,JSON.stringify(task.error),...serializedItems,...(task.resumeScope===undefined?[]:[JSON.stringify(task.resumeScope)])];
    return {full,items,priorStages,indices,serializedItems,sql,parameters};
  }
  write(db:DatabaseSync,task:AutomaticListingTask,change:TaskCheckpointChange,priorRevision:number|null):void{
    if(priorRevision===null){db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(task.id,JSON.stringify(task));return;}
    if(db.prepare(change.sql).run(...change.parameters,task.id,priorRevision).changes!==1)throw new UserFacingError('任务检查点已变化，未覆盖较新的暂停或执行结果');
  }
}
