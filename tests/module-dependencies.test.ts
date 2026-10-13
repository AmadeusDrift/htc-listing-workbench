import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('A06 fact readers and family history do not import application services through a value cycle',()=>{
  const result=JSON.parse(execFileSync(process.execPath,['scripts/check-module-boundaries.mjs'],{encoding:'utf8',maxBuffer:4*1024*1024}));
  assert.deepEqual(result.unresolvedDynamicImports,[]);
  assert.equal(result.cycles.some((cycle:string[])=>cycle.includes('main/amazon/demo.ts')),false);
  assert.equal(result.cycles.some((cycle:string[])=>cycle.includes('main/amazon/service.ts')),false);
  assert.equal(result.cycles.some((cycle:string[])=>cycle.includes('main/ai/adapters.ts')),false,'provider adapters must not participate in domain parser cycles');
  assert.deepEqual(result.cycles,[],'all three inherited value-import clusters must remain eliminated');
});
