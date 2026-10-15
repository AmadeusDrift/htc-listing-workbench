import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readRoundSpend} from '../src/main/automatic-listing/round-spend.ts';

test('new round starts at zero without erasing old costs; recovery of an old call is not a new charge',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec('CREATE TABLE audit_events(action TEXT,created_at TEXT,detail_json TEXT)');
  for(const table of ['ai_calls','ai_image_requests','ai_provider_receipts','ai_spend_reservations'])db.exec(`CREATE TABLE ${table}(id TEXT,record_json TEXT)`);
  const put=(table:string,id:string,record:object)=>db.prepare(`INSERT INTO ${table} VALUES(?,?)`).run(id,JSON.stringify({id,...record}));
  const at='2026-10-15T10:00:00.000Z',later='2026-10-15T10:01:00.000Z';
  const task:any={id:'task',targetId:'target',marketplaceId:'US',items:[{draftId:'draft',productId:'product',sku:'SKU'}]};
  const round:any={roundId:'round',startedAt:at,mode:'from-start',taskRevision:1};
  put('ai_calls','old',{productId:'product',startedAt:'2026-10-14T10:00:00.000Z',status:'FAILED'});
  put('ai_provider_receipts','old-receipt',{callId:'old',costUsd:1.5});
  put('ai_spend_reservations','old',{state:'UNKNOWN',actualUsdMicros:null,bound:{upperUsdMicros:2_000_000}});
  db.prepare('INSERT INTO audit_events VALUES(?,?,?)').run('run.evidence',later,JSON.stringify({taskId:'task',callId:'old'}));
  const before=db.prepare('SELECT record_json FROM ai_spend_reservations').get()!.record_json;
  assert.equal(readRoundSpend(db,task,round).reportedUsdMicros,0);
  put('ai_calls','new',{productId:'product',startedAt:later,status:'SUCCEEDED'});
  put('ai_provider_receipts','new-receipt',{callId:'new',costUsd:.0125});
  for(let i=0;i<2;i++)db.prepare('INSERT INTO audit_events VALUES(?,?,?)').run('run.evidence',later,JSON.stringify({taskId:'task',callId:'new'}));
  put('ai_calls','foreign',{productId:'product',startedAt:later,status:'SUCCEEDED'});
  put('ai_provider_receipts','foreign-receipt',{callId:'foreign',costUsd:10});
  db.prepare('INSERT INTO audit_events VALUES(?,?,?)').run('run.evidence',later,JSON.stringify({taskId:'other-task',callId:'foreign'}));
  const changes=db.prepare('SELECT total_changes() n').get()!.n;
  const result=readRoundSpend(db,task,round);assert.equal(result.reportedUsdMicros,12500);assert.equal(result.unknownCostCalls,0);
  assert.equal(db.prepare('SELECT total_changes() n').get()!.n,changes);assert.equal(db.prepare('SELECT record_json FROM ai_spend_reservations').get()!.record_json,before);
  assert.equal(readRoundSpend(db,task,{...round,startedAt:'2026-10-16T10:00:00.000Z'}).reportedUsdMicros,0);
 }finally{db.close();}
});

test('unknown new request never becomes a fabricated zero-cost success',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec('CREATE TABLE audit_events(action TEXT,created_at TEXT,detail_json TEXT)');for(const table of ['ai_calls','ai_image_requests','ai_provider_receipts'])db.exec(`CREATE TABLE ${table}(id TEXT,record_json TEXT)`);
  const at='2026-10-15T10:00:00.000Z';db.prepare('INSERT INTO ai_calls VALUES(?,?)').run('call',JSON.stringify({id:'call',startedAt:at,status:'FAILED'}));db.prepare('INSERT INTO audit_events VALUES(?,?,?)').run('run.evidence',at,JSON.stringify({taskId:'task',callId:'call'}));
  const result=readRoundSpend(db,{id:'task',items:[]} as any,{startedAt:at} as any);assert.equal(result.reportedUsdMicros,0);assert.equal(result.pendingCalls,1);assert.equal(result.unknownCostCalls,1);
 }finally{db.close();}
});
