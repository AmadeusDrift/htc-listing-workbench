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
    assert.equal(queued.taskCount,0);assert.equal(queued.draftCount,0);assert.notEqual(result.productOrigin,'sample');assert.deepEqual(queued.variantSkus,result.variantSkus);assert.equal(queued.sourceReceiptFingerprint,result.sourceReceiptFingerprint);await assert.rejects(worker.runNormalStage('start'),/S10_NORMAL_START_PENDING_EXACT_DYNAMIC_ROUTES/);
    assert.deepEqual(provider.ledger().filter((row:any)=>row.event==='request').map((row:any)=>row.routeId),['normal-source-list','normal-source-detail']);
    const stopped=await worker.stop();assert.equal(stopped.exitCode,0);assert.equal(stopped.forced,false);await writeFile(join(root,'source-report.json'),JSON.stringify({scope:'Real source import and read-only sales queue checkpoint only',normalExecutable:false,finalIntegrationPassed:false,result,queued,construction:worker.report,stopped,ledger:provider.ledger()},null,2),{flag:'wx'});
  }finally{await worker?.stop();await provider.close();}
});
