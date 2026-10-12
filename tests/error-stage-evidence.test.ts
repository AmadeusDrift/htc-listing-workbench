import test from 'node:test';
import assert from 'node:assert/strict';
import { providerError } from '../src/main/image-generation/adapter.ts';
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
