import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { queryTaskGroups, taskSummary, getTaskItem } from '../src/main/automatic-listing/task-query.ts';
import type { AutomaticListingTask } from '../src/shared/automatic-listing-contracts.ts';

test('ordinary refresh does not recheck saved failure receipts; explicit detail checks only its SKU',()=>{
 const db=new DatabaseSync(':memory:');
 try {
  const task={id:'00000000-0000-4000-8000-000000000001',revision:1,status:'RUNNING',error:null,items:Array.from({length:330},(_,i)=>({key:`row-${i}`,productId:`product-${i}`,variantId:`variant-${i}`,sku:`SKU-${i}`,productTitle:'Saved product',status:i===0?'RUNNING':'FAILED',stage:'DRAFT',error:i===0?null:'Saved failure',outcome:i===0?undefined:{kind:'UNKNOWN',code:'FIELD_RESULT_UNKNOWN'},executionTaskIds:[],draftId:null,stockSets:1,imageStarted:false,imageAttempts:0,batchId:null}))} as unknown as AutomaticListingTask;
  let checks=0;const present=(row:any)=>{checks++;return row;};
  const summary=taskSummary(task,present);
  assert.equal(summary.counts.unknown,329);
  const page=queryTaskGroups(db,task,{revision:1,page:1,pageSize:20,search:''},present,key=>key==='row-0'?'saved-row-version':null);
  assert.equal(checks,0);
  assert.equal(page.kind,'page');
  if(page.kind==='page'){assert.equal(page.groups.length,20);assert.equal(page.groups[0].items[0].detailStamp,'saved-row-version');}
  const detail=getTaskItem(task,{revision:1,itemKey:'row-8'},present);
  assert.equal(detail.kind,'item');assert.equal(checks,1);
  assert.equal(db.prepare('SELECT total_changes() n').get()!.n,0);
 } finally {db.close();}
});
