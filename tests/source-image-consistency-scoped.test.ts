import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { consistencyFixture } from './helpers/source-consistency.ts';
import { readConsistencyView } from '../src/main/source-image-consistency/proof.ts';
import { assertConsistencyHistory, reserveConsistencyAttempt } from '../src/main/source-image-consistency/history.ts';
import { consistencyDecisionKey } from '../src/main/source-image-consistency/contracts.ts';
import { AiService } from '../src/main/ai/service.ts';
import { HostingService } from '../src/main/hosting/service.ts';
import { inheritLegacyPurposeSettings } from '../src/main/ai/purpose-routing.ts';
import { chat, mockStorage, saveInput } from './fixtures/listing-ai.ts';

function decision(context:ReturnType<ReturnType<typeof consistencyFixture>['context']>){return{version:'source-image-consistency/v1',id:randomUUID(),context,fingerprint:consistencyDecisionKey(context),assessmentId:null,decision:'CONFIRMED',reason:'Synthetic scoped image decision',createdAt:new Date().toISOString()};}
test('current view avoids unrelated historical asset chains; global startup/backup validation still rejects them',t=>{
  const f=consistencyFixture(t),g=consistencyFixture(t),context=f.context(),foreign=decision(g.context());
  f.db.prepare('INSERT INTO source_consistency_decisions VALUES(?,?)').run(foreign.id,JSON.stringify(foreign));
  const statements:string[]=[],prepare=f.db.prepare.bind(f.db);
  f.db.prepare=((sql:string)=>{statements.push(sql);return prepare(sql);}) as typeof f.db.prepare;
  try{assert.equal(readConsistencyView(f.db,context).status,'PENDING');}finally{f.db.prepare=prepare;}
  assert.ok(!statements.some(sql=>/PRAGMA table_xinfo|SELECT id,record_json FROM source_consistency_\w+$/i.test(sql)),statements.join('\n'));
  assert.throws(()=>assertConsistencyHistory(f.db),'global integrity entry remains strict for the unrelated invalid chain');
});
test('an older-scope unknown attempt still blocks a newer human decision and costs no additional request',t=>{
  const f=consistencyFixture(t),old=f.context();reserveConsistencyAttempt(f.db,old,{id:randomUUID(),startedAt:new Date().toISOString()});
  const p=f.store.getProduct(f.p.id);f.store.saveProduct({...saveInput(p),variants:saveInput(p).variants.map(v=>({...v,originalSpec:'Red square',normalizedSpec:'Red square'}))});
  const context=f.context(),human=decision(context);f.db.prepare('INSERT INTO source_consistency_decisions VALUES(?,?)').run(human.id,JSON.stringify(human));
  assert.equal(readConsistencyView(f.db,context).status,'UNKNOWN');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM source_consistency_attempts').get()!.n,1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM ai_calls').get()!.n,0);
});
test('all relevant assessments retain original result/call validation, including older nonselected records',async t=>{
  const f=consistencyFixture(t),hosting=new HostingService(f.directory,f.store,mockStorage);let requests=0;
  const ai=new AiService(f.directory,f.store,hosting,mockStorage,{fetch:async(_url,options)=>{
    requests++;const payload=JSON.parse(JSON.parse(String(options?.body)).messages[1].content[0].text);
    return chat({kind:'source-image-consistency',assets:payload.referenceAssets.map((a:any)=>({assetId:a.assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:['Blue'],appearance:['Round'],claims:payload.claims.map((c:any)=>({claimId:c.id,value:c.axis==='color'?'Blue':'Round',visibility:'visible'}))}))});
  }});
  f.cleanup.push(async()=>{await ai.close();await hosting.close();});
  ai.saveConnection({id:'deepseek',apiKey:'scoped-synthetic-key'});ai.saveFunctionSettings({id:'deepseek',model:'deepseek-flash',enabled:true});inheritLegacyPurposeSettings((ai as any).db,'deepseek','deepseek-flash',false);
  await ai.observeSourceConsistency(f.context(),()=>{});
  assert.equal(readConsistencyView(f.db,f.context()).status,'MATCH');
  const original=JSON.parse(String(f.db.prepare('SELECT record_json FROM source_consistency_assessments').get()!.record_json)),latest={...original,id:randomUUID()};
  f.db.prepare('INSERT INTO source_consistency_assessments VALUES(?,?)').run(latest.id,JSON.stringify(latest));
  f.db.prepare('UPDATE source_consistency_assessments SET record_json=? WHERE id=?').run(JSON.stringify({...original,resultId:randomUUID()}),original.id);
  assert.throws(()=>readConsistencyView(f.db,f.context()),'old related history is not silently discarded in favor of newest success');
  assert.equal(requests,1);
});
test('ambiguous scope JSON and a foreign product claiming the selected variant cannot escape local checks',t=>{
  const f=consistencyFixture(t),context=f.context(),human=decision(context);
  for(const raw of [
    JSON.stringify(human).replace('"context":','"context":{"productId":"'+randomUUID()+'","variantId":"'+randomUUID()+'"},"context":'),
    JSON.stringify(human).replace('"productId":','"productId":"'+randomUUID()+'","productId":'),
    JSON.stringify({...human,context:{...context,productId:randomUUID()}}),
  ]){
    f.db.exec('BEGIN');try{f.db.prepare('INSERT INTO source_consistency_decisions VALUES(?,?)').run(human.id,raw);assert.throws(()=>readConsistencyView(f.db,context));}finally{f.db.exec('ROLLBACK');}
  }
});
