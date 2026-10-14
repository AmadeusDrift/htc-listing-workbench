import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, symlink, unlink, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from 'basic-ftp';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectRaster } from '../src/main/image-format.ts';
import { build } from 'esbuild';

const require = createRequire(import.meta.url), run = promisify(execFile);
const providerFile = resolve('tests/fixtures/stabilization/fake-http-provider.mjs');
const runtimeFile = resolve('tests/fixtures/stabilization/pipeline-runtime.mjs');
const guardFile = resolve('tests/fixtures/stabilization/pipeline-network-guard.cjs');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function feature(path: string) {
  let module; try { module = require(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error; }
  assert.ok(module, `S10 foundation missing: ${path}`); return module;
}
async function root() { await mkdir(resolve('.test-data'), { recursive: true }); return mkdtemp(resolve('.test-data/s10-')); }
const routes = [{ id:'chat', method:'POST', path:'/chat', publicUrl:'https://openrouter.ai/api/v1/chat/completions', credential:{header:'authorization',value:'Bearer s10-fixture-only'}, response:{json:{choices:[],usage:{cost:0.01}}} },
  {id:'image',method:'GET',path:'/image',response:{bytes:Buffer.from('fixture-bytes'),contentType:'image/png'}},
  {id:'slow',method:'POST',path:'/slow',response:{json:{complete:true},holdBody:true}}];

test('S10 real HTTP arrival ledger is durable across provider restart; wrong route/auth has no business side effect', async t => {
  const api = await feature(providerFile), directory=await root();
  let provider=await api.createFakeProvider({directory,routes}); t.after(async()=>provider.close());
  const url=provider.origin;
  assert.equal((await fetch(url+'/chat',{method:'POST',headers:{authorization:'Bearer s10-fixture-only'},body:'{"id":1}'})).status,200);
  assert.equal((await fetch(url+'/chat',{method:'POST',headers:{authorization:'Bearer wrong'}})).status,403);
  assert.equal((await fetch(url+'/missing',{method:'POST'})).status,404);
  const rows=provider.ledger();assert.equal(rows.filter((r: any)=>r.event==='request'&&r.routeId==='chat').length,1);
  assert.equal(rows.filter((r: any)=>r.event==='rejected').length,2);
  assert.equal(rows[0].bodySha256,hash(Buffer.from('{"id":1}')));
  assert.ok(!(await readFile(provider.ledgerPath,'utf8')).includes('Bearer'));
  await provider.close();provider=await api.createFakeProvider({directory,routes});
  assert.deepEqual(provider.ledger(),rows);await fetch(provider.origin+'/chat',{method:'POST',headers:{authorization:'Bearer s10-fixture-only'}});
  assert.equal(provider.ledger().filter((r: any)=>r.event==='request').length,2);
});

test('S10 actual early headers precede held body and arrival survives disconnected client',async t=>{
  const api=await feature(providerFile),provider=await api.createFakeProvider({directory:await root(),routes});t.after(()=>provider.close());
  const controller=new AbortController(),response=await fetch(provider.origin+'/slow',{method:'POST',signal:controller.signal});
  assert.equal(response.status,200);assert.equal(provider.ledger().filter((r:any)=>r.event==='headers').length,1);
  const body=response.text();controller.abort();await assert.rejects(body);provider.release('slow');
  assert.equal(provider.ledger().filter((r:any)=>r.event==='request').length,1);
});

test('S10 real basic-ftp upload persists bytes/hash/count; wrong credentials and traversal cannot upload',async t=>{
  const api=await feature(providerFile),provider=await api.createFakeProvider({directory:await root(),routes,ftp:true});t.after(()=>provider.close());
  const ftp=new Client(3000);t.after(()=>ftp.close());
  await ftp.access({host:'127.0.0.1',port:provider.ftp.port,user:'s10-user',password:'s10-password',secure:false});
  const bytes=Buffer.from('actual ftp protocol bytes');await ftp.uploadFrom(Readable.from(bytes),'/s10/one.png');
  assert.deepEqual(await provider.readFtp('/s10/one.png'),bytes);
  assert.equal(provider.ledger().filter((r:any)=>r.event==='ftp-upload'&&r.bodySha256===hash(bytes)).length,1);
  await assert.rejects(ftp.uploadFrom(Readable.from(bytes),'/s10/../escape.png'));
  const bad=new Client(3000);try{await assert.rejects(bad.access({host:'127.0.0.1',port:provider.ftp.port,user:'s10-user',password:'bad'}));}finally{bad.close();}
  assert.equal(provider.ledger().filter((r:any)=>r.event==='ftp-upload').length,1);
});

test('S10 worker guard redirects only exact allowlisted route with fake credential, denies external/wrong port/path/socket/DNS and strips secrets',async t=>{
  const api=await feature(providerFile),runtime=await feature(runtimeFile),directory=await root(),provider=await api.createFakeProvider({directory:join(directory,'server'),routes});t.after(()=>provider.close());
  const policy=await runtime.writePolicy({directory:join(directory,'worker'),provider,guardFile});
  const code=`const assert=require('node:assert/strict');(async()=>{
    assert.equal(process.env.OPENROUTER_API_KEY,undefined);assert.equal(process.env.HTTPS_PROXY,undefined);
    const allowed=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer s10-fixture-only'}});assert.equal(allowed.status,200);
    for(const url of ['https://example.invalid/','http://127.0.0.1:1/chat',${JSON.stringify(provider.origin+'/unknown')},${JSON.stringify(provider.origin+'/chat?unexpected=1')},${JSON.stringify(provider.origin+'/image/../chat')}])await assert.rejects(async()=>fetch(url),/S10_NETWORK_BLOCKED/);
    await assert.rejects(async()=>fetch(${JSON.stringify(provider.origin+'/chat')},{method:'POST',headers:{authorization:'Bearer production-canary'}}),/S10_NETWORK_BLOCKED/);
    assert.throws(()=>require('node:net').connect(443,'203.0.113.1'),/S10_NETWORK_BLOCKED/);
    assert.throws(()=>require('node:net').connect(1,'127.0.0.1'),/S10_NETWORK_BLOCKED/);
    let socket;try{assert.throws(()=>{socket=require('node:net').connect(${provider.port},'127.0.0.1');},/S10_NETWORK_BLOCKED/);}finally{socket?.destroy();}
    assert.throws(()=>require('node:dns').lookup('example.invalid',()=>{}),/S10_NETWORK_BLOCKED/);
    assert.throws(()=>require('node:dgram').createSocket('udp4'),/S10_NETWORK_BLOCKED/);
    assert.throws(()=>new WebSocket('wss://example.invalid'),/S10_NETWORK_BLOCKED/);
    console.log(JSON.stringify({root:process.env.RED_DATA_DIR,blocked:globalThis.__s10Guard.blocked.length}));
  })().catch(e=>{console.error(e);process.exitCode=1});`;
  const output=await run(process.execPath,['--require',guardFile,'-e',code],{windowsHide:true,timeout:10000,env:{...process.env,NODE_OPTIONS:'',S10_POLICY_FILE:policy.path,OPENROUTER_API_KEY:'synthetic-canary',HTTPS_PROXY:'http://external.invalid:1'}});
  const result=JSON.parse(output.stdout);assert.equal(result.root,policy.dataRoot);assert.equal(result.blocked,12);
  assert.equal(provider.ledger().filter((r:any)=>r.event==='request').length,1);
});

test('S10 guard rejects junction policy/data parents before any worker code executes',async()=>{
  const api=await feature(providerFile),runtime=await feature(runtimeFile),directory=await root(),provider=await api.createFakeProvider({directory:join(directory,'server'),routes});
  try {const policy=await runtime.writePolicy({directory:join(directory,'worker'),provider,guardFile});const link=join(directory,'linked');await symlink(join(directory,'worker'),link,'junction');
    try {await assert.rejects(run(process.execPath,['--require',guardFile,'-e','console.log("must-not-run")'],{windowsHide:true,env:{...process.env,NODE_OPTIONS:'',S10_POLICY_FILE:join(link,'policy.json')}}),/S10_PATH_UNTRUSTED/);}finally{await unlink(link);}
    assert.equal((await readFile(policy.path,'utf8')).includes('production-canary'),false);
  } finally {await provider.close();}
});

test('S10 controller owns worker identity/stop, retains reports and fixture inventory without building candidate',async()=>{
  const api=await feature(providerFile),runtime=await feature(runtimeFile),directory=await root(),provider=await api.createFakeProvider({directory:join(directory,'server'),routes});
  try {const policy=await runtime.writePolicy({directory:join(directory,'worker'),provider,guardFile});
    const worker=await runtime.launchWorker({policy,guardFile,entry:resolve('tests/fixtures/stabilization/crash-worker.ts'),args:['foundation']});
    const report=await worker.wait();assert.equal(report.exitCode,0);assert.equal(report.identity.dataRoot,policy.dataRoot);assert.equal(report.identity.sourceCommit.length,40);
    assert.equal(report.identity.executable,process.execPath);assert.equal(report.identity.pid,worker.pid);
    await assert.rejects(runtime.stopWorker({pid:process.pid}),/S10_WORKER_NOT_OWNED/);
    const inventory=await runtime.fixtureInventory();assert.ok(inventory.every((r:any)=>r.sha256.length===64));assert.ok(inventory.some((r:any)=>r.path.endsWith('schema.json')));
    const holding=await runtime.launchWorker({policy,guardFile,entry:resolve('tests/fixtures/stabilization/crash-worker.ts'),args:['hold']});await holding.ready();await holding.stop();const stopped=await holding.wait();assert.equal(stopped.stopRequested,true);
  } finally {await provider.close();}
});

test('S10 deterministic source PNG and complete schema fixtures preserve original bytes and inventory',async()=>{
  const runtime=await feature(runtimeFile);assert.equal(typeof runtime.materializeFixtures,'function','fixture materialization missing');
  const directory=await root(),inventory=await runtime.materializeFixtures(join(directory,'fixtures'));
  const images=inventory.filter((row:any)=>row.kind==='source-image');assert.equal(images.length,2);
  for(const row of images){const bytes=await readFile(row.absolutePath);assert.equal(hash(bytes),row.sha256);const raster=inspectRaster(bytes);assert.equal(raster.width,256);assert.equal(raster.height,256);}
  assert.notEqual(images[0].sha256,images[1].sha256);
  const source=await runtime.fixtureInventory();for(const row of inventory.filter((row:any)=>row.kind==='full-schema'))assert.equal(row.sha256,source.find((s:any)=>s.path===row.sourcePath).sha256);
});

test('S10 isolated Electron dry-run constructs real services, uses native loopback fetch, closes only its own process',async()=>{
  const api=await feature(providerFile),runtime=await feature(runtimeFile);assert.equal(typeof runtime.launchElectron,'function','Electron lifecycle missing');
  const directory=await root(),provider=await api.createFakeProvider({directory:join(directory,'server'),routes:[{id:'foundation',method:'GET',path:'/foundation',response:{json:{foundation:true}}}]});
  try{const policy=await runtime.writePolicy({directory:join(directory,'worker'),provider,guardFile}),entry=join(policy.directory,'pipeline.cjs');
    await build({entryPoints:[resolve('tests/fixtures/stabilization/pipeline-electron.ts')],outfile:entry,bundle:true,platform:'node',target:'node24',format:'cjs',external:['electron'],logLevel:'silent'});
    const worker=await runtime.launchElectron({policy,guardFile,entry});try{const report=worker.report;
      assert.equal(report.identity.dataRoot,policy.dataRoot);assert.equal(report.foundationOnly,true);assert.equal(report.businessStarted,false);
      assert.ok(report.services.includes('ImageWorkflowService'));assert.ok(report.services.includes('AutomaticListingService'));assert.ok(report.services.includes('ProcurementService'));
      assert.equal(report.taskCount,0);assert.equal(report.aiCallCount,0);assert.equal(report.productCount,0);assert.equal(report.nativeFetchProbe.foundation,true);
      assert.equal(typeof worker.probeRejection,'function','Actual Electron guard rejection probe missing');
      const rejected=await worker.probeRejection();assert.equal(rejected.nativeRejected,5);assert.equal(rejected.chromiumRejected,true);
      assert.equal(provider.ledger().filter((row:any)=>row.event==='request').length,1);
    }finally{const stopped=await worker.stop();assert.equal(stopped.exitCode,0);assert.equal(stopped.forced,false);assert.equal(stopped.drained,true);}
  }finally{await provider.close();}
});

test('S10 pipeline CLI cannot claim integration or start tasks while owner contracts are pending',async()=>{
  await assert.rejects(run(process.execPath,[resolve('scripts/e2e-stabilization-pipeline.mjs'),'--pipeline'],{windowsHide:true,timeout:10000,env:{...process.env,NODE_OPTIONS:''}}),/S10_WAITING_FOR_OWNER_CONTRACTS/);
});

test('S10 controller rejects wrong cwd before creating any data or launch files',async()=>{
  const directory=await root();await assert.rejects(run(process.execPath,[resolve('scripts/e2e-stabilization-pipeline.mjs'),'--foundation-dryrun'],{cwd:directory,windowsHide:true,timeout:10000,env:{...process.env,NODE_OPTIONS:''}}),/S10_EXPLICIT_WORKTREE_REQUIRED/);
  assert.deepEqual(await readdir(directory),[]);
});
