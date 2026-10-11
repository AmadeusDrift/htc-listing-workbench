import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from '../src/main/database.ts';
import { CompletionJournal } from '../src/main/listing-ai/completion-journal.ts';
import { recordInvalidAiOutput } from '../src/main/ai/output-diagnostics.ts';
import { validateStoredAiResult } from '../src/main/ai/validation.ts';
const source=resolve('artifacts/automatic-errors-2026-10-09/practical-rerun-evidence.json'),diagnostics=resolve('artifacts/automatic-errors-2026-10-09/practical-listing-user-diagnostics.json');
test('local retained 19 responses recover in an isolated database without new calls or ledger changes', {skip:!existsSync(source)||!existsSync(diagnostics)},()=>{
 const evidence=JSON.parse(readFileSync(source,'utf8')),records=JSON.parse(readFileSync(diagnostics,'utf8')).records;
 mkdirSync(resolve('.test-data'),{recursive:true});const directory=mkdtempSync(resolve('.test-data/recovery19-')),db=openDatabase(directory);
 try{
 for(const [table,values] of [['ai_calls',evidence.calls],['ai_usage_ledger',evidence.ledger],['listing_completion_operations',evidence.operations]] as const)for(const value of values)db.prepare(`INSERT INTO ${table}(id,record_json) VALUES(?,?)`).run(value.id,JSON.stringify(value));
 for(const call of evidence.calls){const diagnostic=records.find((r:any)=>r.record.callId===call.id).record;recordInvalidAiOutput(directory,{call,operation:'amazon-fields',createdAt:diagnostic.createdAt,rejectionStage:diagnostic.rejectionStage,output:diagnostic.output});}
 const calls=db.prepare('SELECT record_json FROM ai_calls ORDER BY id').all(),ledger=db.prepare('SELECT record_json FROM ai_usage_ledger ORDER BY id').all(),journal=new CompletionJournal(db,directory),ids=[];
 for(const op of evidence.operations){
  assert.equal(journal.unknown(op.id),false);const round=op.rounds[0],request={operationId:op.id,callId:round.candidate.id,contextHash:round.contextHash};
  const result=journal.recover(request);ids.push(result.id);assert.equal(result.callId,round.candidate.id);assert.equal(journal.recover(request).id,result.id);
 }
 assert.equal(ids.length,19);assert.equal(new Set(ids).size,19);assert.equal(db.prepare('SELECT id FROM ai_results').all().length,19);
 assert.deepEqual(db.prepare('SELECT record_json FROM ai_calls ORDER BY id').all(),calls);assert.deepEqual(db.prepare('SELECT record_json FROM ai_usage_ledger ORDER BY id').all(),ledger);
 rmSync(resolve(directory,'ai-diagnostics'),{recursive:true});const restarted=new CompletionJournal(db);
 for(const op of evidence.operations){const saved=restarted.get(op.id);assert.equal(restarted.unknown(op.id),false);assert.ok(restarted.result(saved.rounds[0].candidate,saved.rounds[0])!.localRecovery);}
 for(const row of db.prepare('SELECT record_json FROM ai_results').all())validateStoredAiResult(JSON.parse(String(row.record_json)));
 }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});
