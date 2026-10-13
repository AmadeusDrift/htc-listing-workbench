import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
test('usage report does not double count receipts or turn unknown money into zero',async t=>{
  const path='../src/main/ai/usage-report.ts';assert.ok(existsSync(new URL(path,import.meta.url)));const {readAiUsageReport}=await import(path);
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());for(const table of ['ai_usage_ledger','ai_calls','ai_provider_receipts','ai_image_requests'])db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,record_json TEXT NOT NULL)`);
  for(const [id,model] of [['a','openai/gpt-6-luna'],['b','deepseek-flash']]){
    const startedAt='2026-10-13T01:00:00.000Z',providerId=id==='a'?'openrouter':'deepseek';
    db.prepare('INSERT INTO ai_usage_ledger VALUES(?,?)').run(id,JSON.stringify({id,providerId,startedAt,state:'REPORTED',usage:{promptTokens:10,completionTokens:5}}));
    db.prepare('INSERT INTO ai_calls VALUES(?,?)').run(id,JSON.stringify({id,providerId,startedAt,model,purposeSnapshot:{purposeId:'listing_title'}}));
  }
  for(const id of ['r1','r2'])db.prepare('INSERT INTO ai_provider_receipts VALUES(?,?)').run(id,JSON.stringify({id,callId:'a',costUsd:.02}));
  const report=readAiUsageReport(db,{from:'2026-10-13',to:'2026-10-13'});
  assert.equal(report.calls,2);assert.equal(report.reportedCostUsd,.02);assert.equal(report.unknownCostCalls,1);assert.equal(report.totalCostUsd,null);
  assert.equal(report.rows.length,2);assert.equal(readAiUsageReport(db,{from:'2026-10-12',to:'2026-10-12'}).calls,0);
});
