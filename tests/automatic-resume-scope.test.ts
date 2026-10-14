import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeFailureReason, rememberFailure, validateResumeSelection, rowSelected } from '../src/shared/automatic-resume.ts';

test('failure evidence never uses classification time as failure time and keeps prior evidence',()=>{
 const row:any={stage:'IMAGES',error:'第 3 图下载失败',outcome:{classifiedAt:'2026-10-14T00:00:00Z'}};
 rememberFailure(row,null);rememberFailure(row,null);
 assert.equal(row.failureHistory.length,1);assert.equal(row.failureHistory[0].occurredAt,null);
 row.error='第 3 图复核失败';rememberFailure(row,'2026-10-14T01:00:00Z');
 assert.equal(row.failureHistory.length,2);assert.equal(row.failureHistory[0].reason,'第 3 图下载失败');
});
test('arbitrary URLs keys and bodies never reach historical failure UI',()=>{
 const value=sanitizeFailureReason('下载失败 https://example.test/private?key=SECRET api_key=ABC123 body={"token":"SECRET"}');
 assert.match(value,/下载失败/);assert.doesNotMatch(value,/https:|example|SECRET|ABC123|token/);
});
test('selection only grants selected keys and validates image slots',()=>{
 const scope=validateResumeSelection({mode:'targeted',selections:[{key:'one',slots:[3]}]},['one','two']);
 assert.equal(rowSelected(scope,'one'),true);assert.equal(rowSelected(scope,'two'),false);
 assert.throws(()=>validateResumeSelection({mode:'targeted',selections:[{key:'one',slots:[0]}]},['one']));
 assert.throws(()=>validateResumeSelection({mode:'targeted',selections:[{key:'absent'}]},['one']));
});
