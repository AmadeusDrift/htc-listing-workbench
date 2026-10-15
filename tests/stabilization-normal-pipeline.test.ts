import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
const require=createRequire(import.meta.url),runtime=require(resolve('tests/fixtures/stabilization/pipeline-runtime.mjs'));
test('normal worker imports one synthetic source through real native Miaoshou services and preserves explicit measured facts',async()=>{
  let api;try{api=require(resolve('tests/fixtures/stabilization/pipeline-normal-provider.mjs'));}catch(error){if((error as NodeJS.ErrnoException).code!=='MODULE_NOT_FOUND')throw error;}assert.ok(api,'S10 real normal provider missing');
  await mkdir(resolve('.test-data'),{recursive:true});const root=await mkdtemp(resolve('.test-data/s10-normal-')),provider=await api.createNormalProvider({directory:join(root,'server'),fixtureDirectory:join(root,'fixtures')}),guardFile=resolve('tests/fixtures/stabilization/pipeline-network-guard.cjs');
  let worker;try{const policy=await runtime.writePolicy({directory:join(root,'worker'),provider,guardFile});await writeFile(join(policy.dataRoot,'normal-config.json'),JSON.stringify(provider.normalConfig),{flag:'wx'});const entry=join(policy.directory,'normal.cjs');
    await build({entryPoints:[resolve('tests/fixtures/stabilization/pipeline-normal-electron.ts')],outfile:entry,bundle:true,platform:'node',target:'node24',format:'cjs',external:['electron'],logLevel:'silent'});
    worker=await runtime.launchElectron({policy,guardFile,entry});const result=await worker.runNormalStage('source');assert.equal(result.productCount,1);assert.equal(result.sourceReceiptMode,'live');assert.equal(result.factCount,15);assert.equal(result.nativeProtocolSent,2);assert.equal(result.nodeProtocolSent,0);assert.equal(result.aiCalls,0);assert.equal(result.finalIntegrationPassed,false);
    const queued=await worker.runNormalStage('queue');assert.equal(queued.queue.products.length,1);assert.equal(queued.queue.products[0].rows.filter((row:any)=>row.eligible).length,1);
    assert.equal(queued.taskCount,0);assert.equal(queued.draftCount,0);assert.notEqual(result.productOrigin,'sample');assert.deepEqual(queued.variantSkus,result.variantSkus);assert.equal(queued.sourceReceiptFingerprint,result.sourceReceiptFingerprint);
    assert.deepEqual(provider.ledger().filter((row:any)=>row.event==='request').map((row:any)=>row.routeId),['normal-source-list','normal-source-detail']);
    const stopped=await worker.stop();assert.equal(stopped.exitCode,0);assert.equal(stopped.forced,false);await writeFile(join(root,'source-report.json'),JSON.stringify({scope:'Real source import and read-only sales queue checkpoint only',normalExecutable:false,finalIntegrationPassed:false,result,queued,construction:worker.report,stopped,ledger:provider.ledger()},null,2),{flag:'wx'});
  }finally{await worker?.stop();await provider.close();}
});
test('normal Haul worker uses the actual scheduler from source through buyable procurement with seven real generated candidates',async()=>{
  const api=require(resolve('tests/fixtures/stabilization/pipeline-normal-provider.mjs'));
  await mkdir(resolve('.test-data'),{recursive:true});const root=await mkdtemp(resolve('.test-data/s10-normal-whole-')),provider=await api.createNormalProvider({directory:join(root,'server'),fixtureDirectory:join(root,'fixtures')}),guardFile=resolve('tests/fixtures/stabilization/pipeline-network-guard.cjs');
  let worker;try{const policy=await runtime.writePolicy({directory:join(root,'worker'),provider,guardFile});await writeFile(join(policy.dataRoot,'normal-config.json'),JSON.stringify(provider.normalConfig),{flag:'wx'});const entry=join(policy.directory,'normal.cjs');
    await build({entryPoints:[resolve('tests/fixtures/stabilization/pipeline-normal-electron.ts')],outfile:entry,bundle:true,platform:'node',target:'node24',format:'cjs',external:['electron'],logLevel:'silent'});
    worker=await runtime.launchElectron({policy,guardFile,entry});await worker.runNormalStage('source');const result=await worker.runNormalStage('start');
    await writeFile(join(root,'normal-report.json'),JSON.stringify({sourceCommit:process.env.S10_FROZEN_SOURCE,finalIntegrationPassed:false,result,ledger:provider.ledger()},null,2),{flag:'wx'});
    assert.equal(result.normalExecutable,true,JSON.stringify({items:result.task.items.map((row:any)=>({stage:row.stage,status:row.status,error:row.error})),blocked:result.blocked}));assert.equal(result.task.items.length,1);assert.equal(result.task.items[0].status,'DONE');assert.equal(result.drafts[0].listingProgram,'haul');assert.equal(result.workflow.slots.length,7);assert.ok(result.workflow.slots.every((slot:any)=>slot.status==='PASSED'));assert.equal(new Set(result.workflow.slots.map((slot:any)=>slot.assetId)).size,7);assert.equal(result.observation.asin,'B0S10TST01');assert.ok(result.observation.statuses.includes('BUYABLE'));assert.equal(result.procurement.filter((row:any)=>row.eligible).length,1);assert.equal(result.nodeProtocolSent,0);assert.deepEqual(result.blocked,[]);
    const stopped=await worker.stop();assert.equal(stopped.exitCode,0);assert.equal(stopped.forced,false);
  }finally{await worker?.stop();await provider.close();}
});
