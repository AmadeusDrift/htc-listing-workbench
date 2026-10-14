// S10 foundation controller. Full integration is deliberately gated until the
// owner contracts are merged and the root freezes its final source commit.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createFakeProvider } from '../tests/fixtures/stabilization/fake-http-provider.mjs';
import { writePolicy, materializeFixtures, launchElectron } from '../tests/fixtures/stabilization/pipeline-runtime.mjs';
if(process.argv.length===3&&process.argv[2]==='--normal-plan'){
  const {worktreeRoot}=createRequire(import.meta.url)('../tests/fixtures/stabilization/trusted-path.cjs');assert.equal(resolve('.'),worktreeRoot,'S10_EXPLICIT_WORKTREE_REQUIRED');
  const {normalPlan,schemaFixture}=await import('../tests/fixtures/stabilization/pipeline-normal-draft.mjs');
  const schemas=await Promise.all(['drink-coaster-us','figurine-parent-us'].map(name=>schemaFixture(name).then(f=>({name,propertyCount:Object.keys(JSON.parse(f.schema.bytes).properties).length,sha256:f.schema.sha256,checksum:f.definition.schema.checksum}))));
  const report={mode:'normal-plan',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),businessStarted:false,providerStarted:false,workerStarted:false,schemaFixtures:schemas,...normalPlan({sellerId:'S10SELLER',skus:['S10-COASTER-01']})};
  await new Promise((done,reject)=>process.stdout.write(JSON.stringify(report,null,2)+'\n',error=>error?reject(error):done()));process.exit(0);
}
if(process.argv.length!==3||process.argv[2]!=='--foundation-dryrun')throw Error('S10_WAITING_FOR_OWNER_CONTRACTS: only --foundation-dryrun is available; no full pipeline acceptance');
const {worktreeRoot}=createRequire(import.meta.url)('../tests/fixtures/stabilization/trusted-path.cjs');
assert.equal(resolve('.'),worktreeRoot,'S10_EXPLICIT_WORKTREE_REQUIRED');
assert.ok(Number(process.versions.node.split('.')[0])>=24,'Node 24 required');
const startedAt=new Date().toISOString(),sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),worktreeStatus=execFileSync('git',['status','--short'],{encoding:'utf8',windowsHide:true}).trim();
await mkdir(resolve('.test-data'),{recursive:true});const root=await mkdtemp(resolve('.test-data/s10-dryrun-'));
const provider=await createFakeProvider({directory:join(root,'server'),ftp:true,routes:[{id:'foundation',method:'GET',path:'/foundation',response:{json:{foundation:true}}}]});
let worker;
try{const fixtures=await materializeFixtures(join(root,'fixtures')),guardFile=resolve('tests/fixtures/stabilization/pipeline-network-guard.cjs'),policy=await writePolicy({directory:join(root,'worker'),provider,guardFile}),entry=join(policy.directory,'pipeline.cjs');
  await build({entryPoints:[resolve('tests/fixtures/stabilization/pipeline-electron.ts')],outfile:entry,bundle:true,platform:'node',target:'node24',format:'cjs',external:['electron'],logLevel:'silent'});
  worker=await launchElectron({policy,guardFile,entry});const probe=await worker.probeRejection();assert.equal(probe.nativeRejected,5);assert.equal(probe.chromiumRejected,true);
  const stopped=await worker.stop();assert.equal(stopped.exitCode,0);assert.equal(stopped.forced,false);
  const report={scope:'S10 foundation only; no business acceptance',foundationPassed:true,finalIntegrationPassed:false,sourceCommit,worktreeStatus,startedAt,finishedAt:new Date().toISOString(),root,fixtures,construction:worker.report,probe,stopped,
    serverLedger:provider.ledger(),missingOwners:['S02','S03','S04','S05','S06-afterhalf','S07-alias','S08','S09'],notRun:['V01–V20','full npm test','application build','candidate','live','Computer Use']};
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({foundationPassed:true,finalIntegrationPassed:false,sourceCommit,reportPath:join(root,'report.json')}));
}finally{await worker?.stop();await provider.close();}
