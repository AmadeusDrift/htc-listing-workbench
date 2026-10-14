import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, symlink, unlink, readdir } from 'node:fs/promises';
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
    const holding=await runtime.launchWorker({policy,guardFile,entry:resolve('tests/fixtures/stabilization/crash-worker.ts'),args:['hold']});await holding.ready();await holding.stop();const stopped=await holding.wait();assert.equal(stopped.stopRequested,true);assert.equal(stopped.exitCode,0);assert.equal(stopped.signal,null);assert.equal(stopped.forced,false);
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

test('S10 raw host aliases cannot normalize into an owned route; exact public URI and normal URL objects remain valid',async()=>{
  const runtime=await feature(runtimeFile),origin='http://127.0.0.1:49123';
  const provider={origin,routes:[{id:'foundation',method:'GET',path:'/foundation'},{id:'public',method:'POST',path:'/chat',publicUrl:'https://openrouter.ai/api/v1/chat/completions',credential:{header:'authorization',value:'Bearer s10-fixture-only'}}],ftp:null};
  const policy=await runtime.writePolicy({directory:join(await root(),'worker'),provider,guardFile});
  const code=`const assert=require('node:assert/strict'),{mapped}=require(${JSON.stringify(guardFile)}),origin=${JSON.stringify(origin)};
    const aliases=['127.1','2130706433','0x7f000001','0177.0.0.1'],escaped=[];
    for(const host of aliases){try{escaped.push(mapped('http://'+host+':49123/foundation').url);}catch(error){assert.match(String(error),/S10_NETWORK_BLOCKED/);}}
    assert.deepEqual(escaped,[],'raw host aliases must be rejected before normalized-origin acceptance');
    assert.equal(mapped(origin+'/foundation').url,origin+'/foundation');assert.equal(mapped(new URL(origin+'/foundation')).url,origin+'/foundation');
    assert.equal(mapped('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer s10-fixture-only'}}).url,origin+'/chat');
    console.log(JSON.stringify({networkCalls:0,aliasesRejected:aliases.length,validForms:3}));`;
  const output=await run(process.execPath,['--require',guardFile,'-e',code],{windowsHide:true,timeout:10000,env:{...process.env,NODE_OPTIONS:'',S10_POLICY_FILE:policy.path}});
  assert.deepEqual(JSON.parse(output.stdout),{networkCalls:0,aliasesRejected:4,validForms:3});
});

test('S10 normal Node stop rejects forced cleanup and retains the owned worker failure report',async()=>{
  const runtime=await feature(runtimeFile),provider={origin:'http://127.0.0.1:49123',routes:[{id:'foundation',method:'GET',path:'/foundation'}],ftp:null};
  const policy=await runtime.writePolicy({directory:join(await root(),'worker'),provider,guardFile});
  const worker=await runtime.launchWorker({policy,guardFile,entry:resolve('tests/fixtures/stabilization/crash-worker.ts'),args:['ignore-stop']});await worker.ready();
  await assert.rejects(worker.stop(),/S10_WORKER_FORCED_STOP/);const report=await worker.wait();
  assert.equal(report.stopRequested,true);assert.equal(report.forced,true);assert.notEqual(report.signal,null);assert.notEqual(report.exitCode,0);
  assert.equal(report.identity.pid,worker.pid);assert.equal(report.identity.executable,process.execPath);assert.equal(report.identity.dataRoot,policy.dataRoot);
  await assert.rejects(worker.stop(),/S10_WORKER_FORCED_STOP/);
});

test('S10 deliberate crash has a separate command marker and never satisfies normal Node stop',async()=>{
  const runtime=await feature(runtimeFile),provider={origin:'http://127.0.0.1:49123',routes:[{id:'foundation',method:'GET',path:'/foundation'}],ftp:null};
  const policy=await runtime.writePolicy({directory:join(await root(),'worker'),provider,guardFile});
  const worker=await runtime.launchWorker({policy,guardFile,entry:resolve('tests/fixtures/stabilization/crash-worker.ts'),args:['deliberate-crash']});await worker.ready();
  const report=await worker.wait();assert.equal(report.workerMode,'deliberate-crash');assert.equal(report.exitCode,73);assert.equal(report.signal,null);assert.equal(report.forced,false);
  await assert.rejects(worker.stop(),/S10_WORKER_STOP_FAILED/);
});

test('S10 failed teardown bounds a stuck close, records forced cleanup, and preserves the original failure',async()=>{
  const runtime=await feature(runtimeFile);assert.equal(typeof runtime.cleanupFailure,'function','bounded failed teardown missing');
  const failure=new Error('S10_FAULT_EOF'),records: {forced:boolean}[]=[];let attempts=0,forces=0;
  await assert.rejects(runtime.cleanupFailure({close:()=>{attempts++;return attempts===1?new Promise(()=>{}):Promise.resolve();},force:()=>{forces++;},record:(row:{forced:boolean})=>{records.push(row);},timeoutMs:20},failure),(error:unknown)=>error===failure);
  assert.equal(forces,1);assert.equal(attempts,2);assert.deepEqual(records,[{forced:true}]);
});

for(const mode of ['missing-identity','wrong-nonce'])test(`S10 exited-zero ${mode} cannot satisfy normal stop without a verified handshake`,async()=>{
  const runtime=await feature(runtimeFile),provider={origin:'http://127.0.0.1:49123',routes:[{id:'foundation',method:'GET',path:'/foundation'}],ftp:null};
  const policy=await runtime.writePolicy({directory:join(await root(),'worker'),provider,guardFile});
  const worker=await runtime.launchWorker({policy,guardFile,entry:resolve('tests/fixtures/stabilization/crash-worker.ts'),args:[mode]});let identityFailure:unknown;await assert.rejects(worker.ready(),(error:unknown)=>{identityFailure=error;return true;});
  const report=await worker.wait();assert.equal(report.identity,null);assert.equal(report.exitCode,0);assert.equal(report.signal,null);assert.equal(report.forced,false);
  await assert.rejects(worker.stop(),(error:unknown)=>error===identityFailure);await assert.rejects(worker.stop(),(error:unknown)=>error===identityFailure);
});

for(const method of ['request','get'])test(`S10 Node HTTP ${method} freezes validated URL/options and never sends unapproved overrides`,async t=>{
  const api=await feature(providerFile),runtime=await feature(runtimeFile),directory=await root();
  const provider=await api.createFakeProvider({directory:join(directory,'server'),routes:[
    {id:'approved',method:'POST',path:'/approved',credential:{header:'authorization',value:'Bearer s10-fixture-only'},response:{json:{approved:true}}},
    {id:'unapproved',method:'POST',path:'/unapproved',response:{json:{unapproved:true}}},
    {id:'wrong-method',method:'PUT',path:'/approved',response:{json:{wrongMethod:true}}},
  ]});t.after(()=>provider.close());
  const policy=await runtime.writePolicy({directory:join(directory,'worker'),provider:{...provider,routes:provider.routes.filter((row:any)=>row.id==='approved')},guardFile});
  const code=`const http=require('node:http'),origin=${JSON.stringify(provider.origin)},method=${JSON.stringify(method)},headers={authorization:'Bearer s10-fixture-only'};
    const send=(input,options)=>new Promise(done=>{try{const callback=res=>{res.resume();res.on('end',()=>done({status:res.statusCode}));};const req=options===undefined?http[method](input,callback):http[method](input,options,callback);req.on('error',e=>done({denied:String(e).includes('S10_NETWORK_BLOCKED'),error:String(e)}));if(method==='request')req.end('synthetic-probe-only');}catch(e){done({denied:String(e).includes('S10_NETWORK_BLOCKED'),error:String(e)});}});
    (async()=>{const cases=[{path:'/unapproved'},{path:undefined},{hostname:'127.1'},{hostname:'127.0.0.1',host:'other.invalid'},{host:'other.invalid'},{port:${provider.port}+1},{protocol:'https:'},{method:'PUT'},{auth:'unapproved:credential'},{headers:{authorization:'Bearer wrong'}},{headers:{authorization:'Bearer s10-fixture-only',host:'other.invalid'}}];
      const rejected=[];for(const override of cases)rejected.push(await send(origin+'/approved',{method:'POST',headers,...override}));
      const safe=await send(new URL(origin+'/approved'),{method:'POST',headers,hostname:'127.0.0.1',host:'127.0.0.1',port:${provider.port},protocol:'http:',path:'/approved',agent:false,timeout:2000,signal:new AbortController().signal});
      let methodReads=0,headerReads=0;const options={headers:{}};Object.defineProperty(options,'method',{enumerable:true,get:()=>++methodReads===1?'POST':'PUT'});Object.defineProperty(options.headers,'authorization',{enumerable:true,get:()=>++headerReads===1?'Bearer s10-fixture-only':'Bearer wrong'});
      const frozen=await send(origin+'/approved',options);const objectOnly=await send({hostname:'127.0.0.1',port:${provider.port},path:'/approved',method:'POST',headers:['Authorization','Bearer s10-fixture-only'],agent:false});console.log(JSON.stringify({rejected,safe,frozen,objectOnly,methodReads,headerReads}));
    })().catch(e=>{console.error(e);process.exitCode=1;});`;
  const output=await run(process.execPath,['--require',guardFile,'-e',code],{windowsHide:true,timeout:10000,env:{...process.env,NODE_OPTIONS:'',S10_POLICY_FILE:policy.path}});
  const results=JSON.parse(output.stdout),rows=provider.ledger();
  await writeFile(join(directory,`http-${method}-report.json`),JSON.stringify({sourceCommit:(await run('git',['rev-parse','HEAD'],{windowsHide:true})).stdout.trim(),method,policyRoutes:policy.path,results,actualRequests:rows.filter((row:any)=>row.event==='request'),ledgerPath:provider.ledgerPath},null,2));
  assert.equal(rows.filter((row:any)=>row.event==='request'&&row.routeId==='unapproved').length,0,JSON.stringify({results,rows}));
  assert.ok(results.rejected.every((row:any)=>row.denied===true),JSON.stringify(results.rejected));assert.equal(results.safe.status,200);assert.equal(results.frozen.status,200);assert.equal(results.objectOnly.status,200);assert.equal(results.methodReads,1);assert.equal(results.headerReads,1);
  assert.equal(rows.filter((row:any)=>row.event==='request').length,3);
});
