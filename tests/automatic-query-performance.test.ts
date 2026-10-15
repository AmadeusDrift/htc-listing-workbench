import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AutomaticListingService } from '../src/main/automatic-listing/service.ts';

test('queue batches field history reads and reuses synchronous classification only',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec('CREATE TABLE listing_completion_operations(id TEXT,record_json TEXT)');
 const products=Array.from({length:110},(_,i)=>({id:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,title:`Product ${i}`,revision:1,variants:Array.from({length:3},(_,j)=>({id:`v${i}-${j}`,sku:`SKU-${i}-${j}`,originalSpec:`spec ${j}`}))}));
 const items=products.flatMap(p=>p.variants.map(v=>({key:p.id+':'+v.id,productId:p.id,variantId:v.id,sku:v.sku,status:'FAILED',stage:'SOURCES',draftId:null,error:null,outcome:{kind:'SYSTEM_REPAIR',code:'SYSTEM_FAILURE'}})));
 const task={id:'task',revision:1,status:'PAUSED',mode:'demo',sellerId:'s',marketplaceId:'m',items};
 const insert=db.prepare('INSERT INTO listing_completion_operations VALUES(?,?)');
 db.exec('BEGIN');for(let i=0;i<10000;i++)insert.run(`op${i}`,JSON.stringify({safetyIdentity:{productId:'unrelated'},padding:'history '.repeat(50)}));db.exec('COMMIT');
 let scans=0,display=0,raw=0;
 const wrapped={prepare(sql:string){if(sql.startsWith('SELECT id,record_json')&&sql.includes('FROM listing_completion_operations'))scans++;return db.prepare(sql);}};
 const service:any=Object.create(AutomaticListingService.prototype);
 const target={target:{id:'target',mode:'demo',sellerId:'s',marketplaceId:'m'}},rules={revision:1};
 Object.assign(service,{db:wrapped,tasks:new Map([['task',task]]),deps:{amazon:{executionTargetScope:()=>target},rules:()=>rules,store:{getProductSnapshot:(id:string)=>products.find(p=>p.id===id)},images:{},execution:{list:()=>[]}},selectedVariants:(p:any)=>p.variants,
 displayUnknownCode:()=>{display++;return null;},unknownCode:()=>{raw++;return null;}});
 const start=performance.now(),queue=await service.queue({productIds:products.map(p=>p.id),targetId:'target'}),elapsedMs=performance.now()-start;
 t.diagnostic(JSON.stringify({salesSku:items.length,historicalOperations:10000,elapsedMs,fieldHistoryScans:scans,displayChecks:display,rawChecks:raw,synchronousReceiptReads:0}));
 assert.equal(queue.products.length,110);assert.equal(queue.products.flatMap((p:any)=>p.rows).length,330);
 assert.equal(scans,2,'one field history scan at each original consistency boundary');
 assert.equal(display,330);assert.equal(raw,330);
 display=0;raw=0;service.displayUnknownCode=()=>{display++;return 'CATEGORY_RESULT_UNKNOWN';};
 const unknown=await service.queue({productIds:products.map(p=>p.id),targetId:'target'});
 assert.equal(display,330,'same original receipt classification is reused within this read');assert.equal(raw,0);
 assert.ok(unknown.products.every((p:any)=>p.rows.every((r:any)=>r.kind==='UNKNOWN'&&!r.eligible)));
 let changed=false;service.deps.sourceReceipt=()=>{if(!changed){changed=true;db.prepare('UPDATE listing_completion_operations SET record_json=? WHERE id=?').run(JSON.stringify({safetyIdentity:{productId:products[0].id}}),'op0');}return null;};
 await assert.rejects(service.queue({productIds:products.map(p=>p.id),targetId:'target'}),/读取期间范围已变化/);
 assert.ok(queue.products.every((p:any)=>p.rows.every((r:any)=>r.eligible===false&&r.continuationRequired)));
});


