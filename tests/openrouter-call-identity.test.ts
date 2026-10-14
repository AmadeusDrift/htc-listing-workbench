import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {saveProviderReceipt,readProviderReceipt} from '../src/main/ai/receipts.ts';
import {readAiUsageReport} from '../src/main/ai/usage-report.ts';
test('receipt identity and report retain actual upstream without guessing legacy or rejected route',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'or-identity-')),db=new DatabaseSync(':memory:');t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 for(const table of ['ai_usage_ledger','ai_calls','ai_provider_receipts','ai_image_requests'])db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,record_json TEXT NOT NULL)`);
 const at='2026-10-14T10:00:00.000Z',id='11111111-1111-4111-8111-111111111111';
 db.prepare('INSERT INTO ai_image_requests VALUES(?,?)').run(id,JSON.stringify({id,model:'openai/gpt-image-2.5-sunburst',createdAt:at}));
 const capture={gateway:'openrouter' as const,endpoint:'/api/v1/chat/completions',model:'openai/gpt-image-2.5-sunburst',status:200,requestId:'gen-1',receivedAt:at,costUsd:0.04,body:{model:'actual-model-version',openrouter_metadata:{endpoints:{available:[{model:'actual-model-version',provider:'Azure',selected:true}]}},choices:[]}};
 const r=await saveProviderReceipt(db,dir,id,capture,undefined);assert.deepEqual((r as any).executionIdentity,{actualModel:'actual-model-version',actualProvider:'Azure'});
 assert.deepEqual((await readProviderReceipt(db,dir,id) as any).body,capture.body);
 let report=readAiUsageReport(db,{from:'2026-10-14',to:'2026-10-14'}) as any;assert.equal(report.details[0].actualProvider,'Azure');assert.equal(report.details[0].model,capture.model);assert.equal(report.details[0].actualModel,'actual-model-version');assert.equal(report.details[0].startedAt,at);
 const second='22222222-2222-4222-8222-222222222222';db.prepare('INSERT INTO ai_image_requests VALUES(?,?)').run(second,JSON.stringify({id:second,model:capture.model,createdAt:at}));
 await saveProviderReceipt(db,dir,second,{...capture,status:403,body:{error:{message:'regional denial'}}},undefined);
 report=readAiUsageReport(db,{from:'2026-10-14',to:'2026-10-14'}) as any;const failed=report.details.find((v:any)=>v.id===second);assert.equal(failed.actualModel,null);assert.equal(failed.actualProvider,null);assert.equal(failed.httpStatus,403);
});

test('secret echoed model/provider is omitted from both saved receipt and per-call identity',async ()=>{
 const {postOpenRouter}=await import('../src/main/ai/adapters/openrouter-http.ts');
 const key='fixture-private-key',receipts:any[]=[];
 await assert.rejects(postOpenRouter('/api/v1/chat/completions',{model:'requested'},{apiKey:key},new AbortController().signal,{fetch:async()=>new Response(JSON.stringify({model:key,provider:'Azure'})),now:()=>new Date(),nonce:()=>'',maxResponseBytes:4096,onProviderReceipt:r=>{receipts.push(r);}}));
 assert.equal(receipts.length,1);assert.equal(receipts[0].body,'[omitted: credential echo]');assert.equal(JSON.stringify(receipts).includes(key),false);
});

test('documented routing metadata distinguishes fallback success, ambiguity, candidates and cache hits',async()=>{
 const {openRouterExecutionIdentity:identity}=await import('../src/main/ai/execution-identity.ts');
 const model='openai/model',selected={model,provider:'Azure',selected:true};
 assert.deepEqual(identity({model,openrouter_metadata:{endpoints:{available:[selected]}}},200),{actualModel:model,actualProvider:'Azure'});
 assert.equal(identity({model,openrouter_metadata:{attempts:[{model,provider:'OpenAI',status:503},{model,provider:'Azure',status:200}]}},200).actualProvider,'Azure');
 for(const raw of [{model,provider:'Azure'},{model,openrouter_metadata:{endpoints:{available:[{...selected,selected:false}]}}},{model,openrouter_metadata:{endpoints:{available:[selected,selected]}}},{model,openrouter_metadata:{attempts:[{...selected,status:403}]}}])assert.equal(identity(raw,200).actualProvider,null);
 assert.equal(identity({model,openrouter_metadata:{endpoints:{available:[selected]}}},403).actualProvider,null);
 assert.deepEqual(identity({model:model+'-20260922',openrouter_metadata:{endpoints:{available:[selected]}}},200),{actualModel:model+'-20260922',actualProvider:'Azure'});
 assert.deepEqual(identity({model:model+'-20260922',openrouter_metadata:{attempts:[{...selected,status:200}]}} ,200),{actualModel:model+'-20260922',actualProvider:'Azure'});
 assert.equal(identity({model,openrouter_metadata:{attempts:[{provider:'Azure',model:{bad:true},status:200}]}},200).actualProvider,null);
});

