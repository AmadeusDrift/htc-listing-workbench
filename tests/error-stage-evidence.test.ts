import test from 'node:test';
import assert from 'node:assert/strict';
import { providerError } from '../src/main/image-generation/errors.ts';
import { publicError } from '../src/main/security.ts';

for(const status of [400,403,429,500,502])test(`image HTTP ${status} retains safe numeric evidence and result certainty`,()=>{
  const error=providerError(status,{error:{message:'Bearer sk-private https://private.test/image?token=secret'}});
  assert.equal((error as any).httpStatus,status);
  assert.match(publicError(error),new RegExp(`HTTP ${status}`));
  assert.match(publicError(error),status<500?/DEFINITIVE_FAILURE/:/RESULT_UNKNOWN/);
  assert.doesNotMatch(JSON.stringify(error),/sk-private|private.test|secret/);
});
test('unknown local failures make no unsupported disk diagnosis',()=>{
  assert.doesNotMatch(publicError(new Error('unknown')),/磁盘|文件格式/);
  assert.match(publicError(Object.assign(new Error(),{code:'ENOSPC'})),/磁盘空间不足/);
});

import { recordErrorEvidence } from '../src/main/error-evidence.ts';
import { AiError } from '../src/main/ai/errors.ts';
import { randomUUID } from 'node:crypto';
test('diagnostics are bounded, allowlisted and never replace an exception',()=>{
  const rows:Record<string,unknown>[]=[];
  const original=Object.assign(new Error('https://private?token=secret'),{code:'ENOSPC'});
  original.stack='Error: secret\n at save (C:/private/src/main/image-generation/service.ts:212:3)';
  recordErrorEvidence(detail=>rows.push(detail),original,{stage:'image-generation.save'});
  assert.deepEqual(rows,[{version:1,stage:'image-generation.save',code:'ENOSPC',callsite:'src/main/image-generation/service.ts:212:3'}]);
  assert.doesNotThrow(()=>recordErrorEvidence(()=>{throw Error('write failed');},original,{stage:'image-generation.save'}));
  const hostile=new Proxy({}, {get(){throw Error('hostile accessor');}});
  assert.doesNotThrow(()=>recordErrorEvidence(()=>{},hostile,{stage:'image-generation.save'}));
  assert.equal(original.message,'https://private?token=secret');
});
test('structured failed evidence retains exact call, abort source and safe finer reason', () => {
  const rows: Record<string, unknown>[] = [], callId = randomUUID(), operationId = randomUUID();
  const error = Object.assign(new AiError('TIMEOUT'), { callId, abortSource: 'BODY_TIMEOUT', certainty: 'SENT_UNKNOWN', diagnosticReason: 'RESPONSE_READ_FAILED', headers: { Authorization: 'Bearer sk-bait' } });
  recordErrorEvidence(detail => rows.push(detail), error, { stage: 'fields', operationId } as any);
  assert.equal(rows[0].callId, callId); assert.equal(rows[0].operationId, operationId); assert.equal(rows[0].abortSource, 'BODY_TIMEOUT'); assert.equal(rows[0].certainty, 'SENT_UNKNOWN'); assert.equal(rows[0].diagnosticReason, 'RESPONSE_READ_FAILED');
  assert.doesNotMatch(JSON.stringify(rows), /Authorization|sk-bait|Bearer/);
});
