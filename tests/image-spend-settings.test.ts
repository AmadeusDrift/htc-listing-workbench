import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {WorkspaceStore} from '../src/main/store.ts';
import {openDatabase} from '../src/main/database.ts';
import {ImageGenerationService} from '../src/main/image-generation/service.ts';
import {installImageGenerationIpc} from '../src/main/image-generation-ipc.ts';
import {AiSpendBudget} from '../src/main/ai/spend-budget.ts';
import {imageSpendBound,priceEvidence} from '../src/main/ai/spend-records.ts';
import {transaction} from '../src/main/application/transaction.ts';
const storage={isEncryptionAvailable:()=>true,encryptString:(s:string)=>Buffer.from(s),decryptString:(b:Buffer)=>b.toString()};
async function fixture(t:test.TestContext){await mkdir(resolve('.test-data'),{recursive:true});const root=await mkdtemp(resolve('.test-data/s08-settings-')),store=new WorkspaceStore(root),db=openDatabase(root);let requests=0;const create=()=>new ImageGenerationService(root,store,storage,{decodePreview:b=>b,fetch:async()=>{requests++;throw Error('Settings cannot use a network');}}),service=create();t.after(async()=>{await service.close();db.close();store.close();await rm(root,{recursive:true,force:true});});return{root,store,db,service,create,get requests(){return requests;}};}

test('image money status and its two IPC methods are local, readonly and never invent a stored policy revision',async t=>{
 const f=await fixture(t),before=f.db.prepare('SELECT total_changes() n').get()!.n,handlers=new Map<string,{count:number;invoke:(...a:unknown[])=>unknown}>();installImageGenerationIpc(f.service,(channel,count,invoke)=>handlers.set(channel,{count,invoke}));assert.equal(handlers.get('red:image-generation:spend-status')?.count,0);assert.equal(handlers.get('red:image-generation:spend-limit-save')?.count,1);
 const first=f.service.getSpendStatus();assert.equal(first.currency,'USD');assert.equal(first.unit,'microUSD');assert.equal(first.daily.limitUsdMicros,null);assert.equal(first.daily.policyUpdatedAt,null);assert.equal(first.controlledLifetime.limitUsdMicros,5_000_000);assert.equal(first.controlledRunStatus,'not-registered');assert.equal(first.quoteStatus,'not-checked');assert.equal(first.daily.unknownCalls,0);
 assert.deepEqual(f.service.getSpendStatus(),first);assert.deepEqual(handlers.get('red:image-generation:spend-status')!.invoke(),first);assert.equal(f.db.prepare('SELECT total_changes() n').get()!.n,before);assert.equal(f.requests,0);
});

test('daily USD limits use exact at-most-six decimals and a persisted monotonic CAS token',async t=>{
 const f=await fixture(t),initial=f.service.getSpendStatus();const first=f.service.setDailySpendLimit({limitUsd:'0.000001',expectedUpdatedAt:null});assert.equal(first.daily.limitUsdMicros,1);assert.ok(first.daily.policyUpdatedAt);assert.notEqual(first.daily.policyUpdatedAt,initial.daily.policyUpdatedAt);
 assert.throws(()=>f.service.setDailySpendLimit({limitUsd:'9',expectedUpdatedAt:null}),(e:any)=>e.diagnosticReason==='SPEND_POLICY_CONFLICT');assert.throws(()=>f.service.setDailySpendLimit({limitUsd:'0.0000001',expectedUpdatedAt:first.daily.policyUpdatedAt}),(e:any)=>e.diagnosticReason==='SPEND_LIMIT_INVALID');assert.equal(f.service.getSpendStatus().daily.limitUsdMicros,1);
 const second=f.service.setDailySpendLimit({limitUsd:'0.123456',expectedUpdatedAt:first.daily.policyUpdatedAt});assert.equal(second.daily.limitUsdMicros,123_456);assert.notEqual(second.daily.policyUpdatedAt,first.daily.policyUpdatedAt);assert.throws(()=>f.service.setDailySpendLimit({limitUsd:'1',expectedUpdatedAt:first.daily.policyUpdatedAt}));
 for(const limitUsd of ['', '1e-6','-1','0.0000000','1.1234567',1])assert.throws(()=>f.service.setDailySpendLimit({limitUsd,expectedUpdatedAt:second.daily.policyUpdatedAt}));assert.throws(()=>f.service.setDailySpendLimit({limitUsd:'5',expectedUpdatedAt:second.daily.policyUpdatedAt,scopeId:'renderer-cannot-grant'}));assert.equal(f.service.getSpendStatus().controlledLifetime.limitUsdMicros,5_000_000);assert.equal(f.requests,0);
});

test('two image services cannot both save from the same policy revision',async t=>{
 const f=await fixture(t),other=f.create();try{const first=f.service.setDailySpendLimit({limitUsd:'1',expectedUpdatedAt:null}),results=await Promise.allSettled([Promise.resolve().then(()=>f.service.setDailySpendLimit({limitUsd:'2',expectedUpdatedAt:first.daily.policyUpdatedAt})),Promise.resolve().then(()=>other.setDailySpendLimit({limitUsd:'3',expectedUpdatedAt:first.daily.policyUpdatedAt}))]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.diagnosticReason==='SPEND_POLICY_CONFLICT').length,1);assert.equal(f.requests,0);}finally{await other.close();}
});

test('lowering or removing a daily money limit retains every unknown hold and the fixed lifetime maximum',async t=>{
 const f=await fixture(t),status=f.service.setDailySpendLimit({limitUsd:'0.1',expectedUpdatedAt:null}),budget=new AiSpendBudget(f.db),model='openai/gpt-image-2.5-sunburst',body=JSON.stringify({model,n:1}),now=new Date(),bound=imageSpendBound(body,priceEvidence(model,{id:model,endpoints:[{pricing:[{billable:'output_image',unit:'image',cost_usd:.04}]}]},now),now.toISOString())!,hash=(s:string)=>createHash('sha256').update(s).digest('hex'),id=randomUUID();transaction(f.db,()=>{budget.reserveInTransaction(f.db,{id,businessKey:hash('synthetic-settings'),requestSha256:hash(body),model,purpose:'image_generation',scopeId:null},body,bound);budget.markUnknownInTransaction(f.db,id);});const original=budget.list()[0],used=f.service.getSpendStatus();assert.equal(used.daily.heldUsdMicros,40_000);assert.equal(used.daily.unknownCalls,1);assert.equal(used.daily.remainingUsdMicros,60_000);
 const lowered=f.service.setDailySpendLimit({limitUsd:'0.03',expectedUpdatedAt:status.daily.policyUpdatedAt});assert.equal(lowered.daily.remainingUsdMicros,0);assert.equal(lowered.daily.heldUsdMicros,40_000);assert.deepEqual(budget.list()[0],original);const unlimited=f.service.setDailySpendLimit({limitUsd:null,expectedUpdatedAt:lowered.daily.policyUpdatedAt});assert.equal(unlimited.daily.limitUsdMicros,null);assert.equal(unlimited.daily.heldUsdMicros,40_000);assert.equal(unlimited.daily.unknownCalls,1);assert.equal(unlimited.controlledLifetime.limitUsdMicros,5_000_000);assert.deepEqual(budget.list()[0],original);assert.equal(f.requests,0);
});
