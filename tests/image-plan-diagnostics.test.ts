import test from 'node:test';
import assert from 'node:assert/strict';
import {requestDeepSeekJson} from '../src/main/ai/adapters.ts';
const envelope=(content:unknown,finish='stop')=>({id:'safe-fixture',usage:{prompt_tokens:1,completion_tokens:2},choices:[{finish_reason:finish,message:{content}}]});
test('image plan pre-parse failures retain safe diagnostics and fixed phase reasons',async()=>{
  const cases:[string,string,string][]=[[JSON.stringify({...envelope('{}'),usage:null}),'RESPONSE_ENVELOPE_INVALID','{}'],[JSON.stringify({...envelope('{}'),choices:[]}), 'RESPONSE_ENVELOPE_INVALID',''],['{"choices":[','RESPONSE_ENVELOPE_JSON_INVALID','{"choices":['],[JSON.stringify(envelope('{"ok":true}','length')),'RESPONSE_NOT_COMPLETE','{"ok":true}'],[JSON.stringify(envelope(null)),'RESPONSE_CONTENT_MISSING',''],[JSON.stringify(envelope('{broken')),'RESPONSE_JSON_INVALID','{broken'],[JSON.stringify(envelope('{"note":"\\u0066ixture-secret"}')),'RESPONSE_SECRET_ECHO','[omitted: credential echo]']];
  for(const [raw,reason,expected] of cases){let captured:unknown;await assert.rejects(requestDeepSeekJson({operation:'image-plan'},'JSON','deepseek-flash',{apiKey:'fixture-secret'},new AbortController().signal,{now:()=>new Date(),nonce:()=>'',maxResponseBytes:1000000,fetch:async()=>new Response(raw),onUntrustedOutput:v=>{captured=v;}}),(e:any)=>e.code==='OUTPUT_INVALID'&&e.diagnosticReason===reason);assert.notEqual(captured,undefined);if(expected)assert.equal(captured,expected);assert.ok(!JSON.stringify(captured).includes('fixture-secret'));}
});
