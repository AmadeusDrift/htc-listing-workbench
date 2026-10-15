import { cpus, totalmem } from 'node:os';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { WorkspaceStore } from '../src/main/store.ts';
import { defaultListingRules } from '../src/shared/listing-rules.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { AutomaticListingService } from '../src/main/automatic-listing/service.ts';
import { openDatabase } from '../src/main/database.ts';
import { validateAutomaticListingTask } from '../src/main/automatic-listing/records.ts';
import { DEFAULT_ITEM_LABEL_FORMAT } from '../src/shared/item-label-contracts.ts';
import { installAutomaticListingIpc } from '../src/main/automatic-listing-ipc.ts';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const at='2026-10-14T08:00:00.000Z', hash='a'.repeat(64);
function fixture(t:test.TestContext){
 mkdirSync(resolve('.test-data'),{recursive:true});const directory=mkdtempSync(resolve('.test-data/s09-query-')),db=openDatabase(directory);
 const insert=db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)');
 db.exec('BEGIN');
 for(let n=0;n<16;n++){
  const items=Array.from({length:330},(_,i)=>({key:id(i%100+1)+':'+id(i+1001),productId:id(i%100+1),productRevision:1,sourceStamp:hash,productTitle:`Source ${i%100}`,variantId:id(i+1001),sku:`SYN-${n}-${i}`,stockSets:5,sourcesPrepared:true,status:i<253?'PENDING':'FAILED',stage:'DRAFT',draftId:id(30000+n*1000+i),executionTaskIds:[],imageStarted:false,imageAttempts:0,repairAttempts:0,repair:null,batchId:null,error:i<253?null:'Saved synthetic failure',failureHistory:Array.from({length:20},(_,j)=>({version:1,stage:'DRAFT',reason:`Historical local check ${j}: `+'synthetic '.repeat(100),occurredAt:at,source:'local-check'})),classification:{productType:'BOX',reason:'Synthetic classification '.repeat(25),keywords:['box'],candidateTypes:['BOX',...Array.from({length:49},(_,j)=>`TYPE_${j}`)],decisionIds:[id(200001),id(200002)],judged:true,classifiedAt:at}}));
  const task=validateAutomaticListingTask({id:id(400000+n),revision:1,status:'PAUSED',targetId:'store',targetName:'Synthetic target',sellerId:'synthetic',marketplaceId:'US',mode:'demo',targetStamp:hash,profileId:'alpha',profileStamp:hash,rulesStamp:hash,ruleRevision:1,productType:'BOX',locale:'en_US',labelFormat:DEFAULT_ITEM_LABEL_FORMAT,items,createdAt:at,updatedAt:at,error:null});insert.run(task.id,JSON.stringify(task));
 }
 db.exec('COMMIT');
 let effects=0;const forbidden=()=>{effects++;throw Error('S09 query must not invoke a business dependency');};
 const service=new AutomaticListingService(directory,{store:{getProduct:forbidden,getProductSnapshot:forbidden},rules:forbidden,amazon:{},hosting:{},images:{},execution:{},followup:{},procurement:{},labels:{}} as any);
 const closers:(()=>void)[]=[];t.after(async()=>{for(const close of closers)close();await service.close();db.close();rmSync(directory,{recursive:true,force:true,maxRetries:5});});
 const own=(service as any).db, stamp=()=>createHash('sha256').update(JSON.stringify(db.prepare('SELECT * FROM automatic_listing_tasks ORDER BY id').all())).digest('hex');
 return {service:service as any,db,own,stamp,directory,closers,effects:()=>effects};
}
test('task summaries and group pages read original production owner without cloning heavy history',async t=>{
 const f=fixture(t),before=f.stamp(),changes=f.own.prepare('SELECT total_changes() n').get().n;
 const samples:{name:string;bytes:number;elapsedMs:number;maxGapMs:number}[]=[];
 async function measure(name:string,work:()=>unknown){await yieldLoop();let last=performance.now(),gap=0,active=true;const beat=()=>{const now=performance.now();gap=Math.max(gap,now-last);last=now;if(active)setImmediate(beat);};setImmediate(beat);const start=performance.now(),json=JSON.stringify(work()),elapsedMs=performance.now()-start;await yieldLoop();active=false;samples.push({name,bytes:Buffer.byteLength(json),elapsedMs,maxGapMs:gap});}
 for(let n=0;n<3;n++)await measure('full-list-plus-get',()=>({list:f.service.list(),selected:f.service.get(id(400015))}));
 for(let n=0;n<10;n++)await measure('summary-plus-page20',()=>({summaries:f.service.queryTaskSummaries({taskIds:[id(400015)],page:1,pageSize:20}),page:f.service.queryTaskGroups({taskId:id(400015),revision:1,page:1,pageSize:20,search:''})}));
 assert.ok(samples.find(s=>s.name==='summary-plus-page20')!.bytes<samples[0].bytes/100);
 t.diagnostic(JSON.stringify({fixture:{tasks:16,currentSalesSku:330,sourceLinks:100,historyEventsPerItem:20,candidatesPerItem:50,sha256:before},node:process.version,cpu:cpus()[0]?.model,logicalCpus:cpus().length,memoryBytes:totalmem(),samples}));
 const memory=f.service.tasks.get(id(400015)).items[0],descriptor=Object.getOwnPropertyDescriptor(memory,'failureHistory');Object.defineProperty(memory,'failureHistory',{configurable:true,get(){throw Error('Heavy history read during lightweight query');}});
 const summaries=f.service.queryTaskSummaries({taskIds:[id(400015)],page:1,pageSize:20});
 assert.equal(summaries.total,1);assert.equal(summaries.rows[0].salesSkuCount,330);assert.equal(summaries.rows[0].sourceProductCount,100);
 assert.equal(Object.values(summaries.rows[0].counts).reduce((s:number,n:any)=>s+n,0),330);
 assert.equal('items' in summaries.rows[0],false);
 const page=f.service.queryTaskGroups({taskId:id(400015),revision:1,page:1,pageSize:20,search:''});
 assert.equal(page.kind,'page');assert.equal(page.total,100);assert.equal(page.groups.length,20);
 const payload=JSON.stringify({summaries,page});assert.ok(Buffer.byteLength(payload)<100_000,Buffer.byteLength(payload).toString());
 assert.doesNotMatch(payload,/failureHistory|candidateTypes|decisionIds|Historical local check/);
 Object.defineProperty(memory,'failureHistory',descriptor!);
 const second=f.service.queryTaskGroups({taskId:id(400015),revision:1,page:2,pageSize:20,search:''});assert.equal(new Set([...page.groups,...second.groups].map((g:any)=>g.productId)).size,40);
 const searched=f.service.queryTaskGroups({taskId:id(400015),revision:1,page:1,pageSize:20,search:'SYN-15-329'});assert.equal(searched.total,1);assert.equal(searched.groups[0].productId,id(30));
 const item=f.service.getTaskItem({taskId:id(400015),revision:1,itemKey:searched.groups[0].items.at(-1).key});assert.equal(item.kind,'item');assert.equal(item.item.failureHistory.length,20);
 item.item.failureHistory[0].reason='mutated renderer copy';assert.notEqual(f.service.getTaskItem({taskId:id(400015),revision:1,itemKey:item.item.key}).item.failureHistory[0].reason,item.item.failureHistory[0].reason);
 for(let n=0;n<100;n++){f.service.queryTaskSummaries({taskIds:[id(400015)],page:1,pageSize:20});f.service.queryTaskGroups({taskId:id(400015),revision:1,page:1,pageSize:20,search:''});}
 assert.equal(f.effects(),0);assert.equal(f.own.prepare('SELECT total_changes() n').get().n,changes);assert.equal(f.stamp(),before);
});
test('query bounds, scoped filtering, revision conflicts and resume candidates keep exact identities',t=>{
 const f=fixture(t),query={taskId:id(400015),revision:1,page:1,pageSize:20};
 assert.deepEqual(f.service.queryTaskGroups({...query,revision:2,search:''}),{kind:'revision-conflict',taskId:id(400015),revision:1});
 assert.deepEqual(f.service.getTaskItem({taskId:id(400015),revision:2,itemKey:'foreign'}),{kind:'revision-conflict',taskId:id(400015),revision:1});
 assert.throws(()=>f.service.getTaskItem({taskId:id(400015),revision:1,itemKey:'foreign'}),/不存在|范围/);
 for(const pageSize of [0,21,10000])assert.throws(()=>f.service.queryTaskSummaries({page:1,pageSize}),/分页/);
 assert.throws(()=>f.service.queryTaskSummaries({taskIds:[id(400015),id(400015)],page:1,pageSize:20}),/重复/);
 assert.equal(f.service.queryTaskSummaries({taskIds:[],page:1,pageSize:20}).total,0);
 const rows=f.service.queryResumeItems(query);assert.equal(rows.kind,'page');assert.equal(rows.total,330);assert.equal(rows.rows.length,20);assert.deepEqual(Object.keys(rows.rows[0]).sort(),['draftId','key','sku','stage']);
 assert.equal(f.service.queryTaskSummaries({page:999,pageSize:20}).page,1);
 const original=f.service.tasks.get(id(400000));for(let n=16;n<25;n++)f.service.tasks.set(id(400000+n),{...original,id:id(400000+n)});original.status='RUNNING';const background=f.service.queryTaskSummaries({page:1,pageSize:20});assert.equal(background.active,true);assert.equal(background.rows.some((r:any)=>r.id===original.id),false);original.status='COMPLETED';assert.notEqual(f.service.queryTaskSummaries({page:1,pageSize:20}).lifecycleSignature,background.lifecycleSignature);original.status='PAUSED';for(let n=16;n<25;n++)f.service.tasks.delete(id(400000+n));
 const saved=f.db.prepare('SELECT id,record_json FROM automatic_work_batches').get()!,batch=JSON.parse(String(saved.record_json));batch.taskIds=[id(400015)];f.db.prepare('UPDATE automatic_work_batches SET record_json=? WHERE id=?').run(JSON.stringify(batch),saved.id);assert.equal(f.service.queryTaskSummaries({workBatchId:batch.id,page:1,pageSize:20}).total,1);batch.taskIds.push(id(400014));f.db.prepare('UPDATE automatic_work_batches SET record_json=? WHERE id=?').run(JSON.stringify(batch),saved.id);assert.equal(f.service.queryTaskSummaries({workBatchId:batch.id,page:1,pageSize:20}).total,2);assert.throws(()=>f.service.queryTaskSummaries({workBatchId:batch.id,taskIds:[],page:1,pageSize:20}),/不能同时/);
 const handlers=new Map();installAutomaticListingIpc(f.service,(name,arity,fn)=>{handlers.set(name,{arity,fn});},{confirm:async()=>{throw Error('query requested confirmation');},audit:()=>{throw Error('query wrote audit');}});
 for(const [name,arg] of [['summaries',{taskIds:[],page:1,pageSize:20}],['groups',{...query,search:''}],['item',{taskId:query.taskId,revision:1,itemKey:id(1)+':'+id(1001)}],['resume-items',query]] as const){const route=handlers.get('red:automatic-listing:'+name);assert.equal(route.arity,1);assert.ok(route.fn(arg));}
 assert.equal(f.effects(),0);
});

test('queue uses the real read-only product snapshot without maintenance reads or task writes',async t=>{
 const f=fixture(t),store=new WorkspaceStore(f.directory);
 f.closers.push(()=>store.close());const product=store.createProduct(),deps=(f.service as any).deps;let maintenance=0;store.getProduct=()=>{maintenance++;throw Error('maintenance read forbidden');};
 Object.assign(deps,{store,rules:()=>defaultListingRules(),amazon:{executionTargetScope:()=>({target:{mode:'demo',sellerId:'other',marketplaceId:'US'}})},execution:{list:()=>[]}});
 const before=f.stamp(),changes=f.own.prepare('SELECT total_changes() n').get().n;
 for(let n=0;n<10;n++){const queue=await f.service.queue({productIds:[product.id],targetId:'store'});assert.equal(queue.products.length,1);}
 assert.equal(maintenance,0);assert.equal(f.own.prepare('SELECT total_changes() n').get().n,changes);assert.equal(f.stamp(),before);
});
