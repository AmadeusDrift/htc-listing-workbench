import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { mkdir, mkdtemp, symlink, unlink, rm, writeFile, copyFile, readdir } from 'node:fs/promises';
const run = promisify(execFile);
const guard = resolve('tests/fixtures/stabilization/network-guard.cjs');

test('S00 preload strips service environment and blocks network before tests initialize', async () => {
  const result = await run(process.execPath, ['--require', guard, '-e', `
    const assert=require('node:assert/strict');
    assert.equal(process.env.OPENROUTER_API_KEY,undefined);
    assert.equal(process.env.FIRMNESS_SOURCE_DB,undefined);
    assert.equal(process.env.RED_DATA_DIR,process.env.HTC_STABILIZATION_DATA_DIR);
    for(const attempt of [()=>fetch('https://openrouter.ai'),()=>require('node:net').connect(443,'api.deepseek.com'),()=>require('node:dns').lookup('example.com',()=>{})]) {
      assert.throws(attempt,/STABILIZATION_NETWORK_BLOCKED/);
    }
    assert.equal(globalThis.__stabilizationNetwork.blocked.length,3);
    console.log('guard-pass');
  `], { windowsHide: true, env: { ...process.env, HTC_STABILIZATION_DATA_DIR: resolve('.test-data/stabilization'), RED_DATA_DIR: resolve('unsafe-outside-test-root'), OPENROUTER_API_KEY: 'synthetic-canary', FIRMNESS_SOURCE_DB: 'synthetic-private-canary' } });
  assert.match(result.stdout, /guard-pass/);
});

test('S00 preload preserves validated per-test child roots and harness paths',async()=>{
  const root=resolve('.test-data/synthetic-child');
  const preload=resolve('.test-data/synthetic-child/preload.cjs');
  const result=await run(process.execPath,['--require',guard,'-e',`console.log(JSON.stringify({root:process.env.RED_DATA_DIR,preload:process.env.RED_E2E_PRELOAD}));`],{
    windowsHide:true,env:{...process.env,HTC_STABILIZATION_DATA_DIR:resolve('.test-data/stabilization'),RED_DATA_DIR:root,RED_E2E_PRELOAD:preload},
  });
  assert.deepEqual(JSON.parse(result.stdout),{root,preload});
});

test('S00 preload remains anchored to the worktree when an isolated child changes cwd',async()=>{
  const child=resolve('.test-data/stabilization/child-cwd');await mkdir(child,{recursive:true});
  const result=await run(process.execPath,['--require',guard,'-e','console.log(process.env.RED_DATA_DIR)'],{
    cwd:child,windowsHide:true,env:{...process.env,HTC_STABILIZATION_DATA_DIR:resolve('.test-data/stabilization'),RED_DATA_DIR:resolve('.test-data/stabilization')},
  });
  assert.equal(result.stdout.trim(),resolve('.test-data/stabilization'));
});

test('S00 rejects synthetic junction ancestors for data and harness paths',async()=>{
  await mkdir(resolve('.test-data'),{recursive:true});
  const root=await mkdtemp(resolve('.test-data/guard-junction-'));
  const target=resolve(root,'target'),link=resolve(root,'link');
  await mkdir(target);await writeFile(resolve(target,'preload.cjs'),'throw Error("Must not execute");');
  await symlink(target,link,'junction');
  try {
    for(const variable of ['HTC_STABILIZATION_DATA_DIR','RED_DATA_DIR','RED_E2E_PRELOAD','RED_E2E_HTML']) {
      await assert.rejects(run(process.execPath,['--require',guard,'-e','console.log("unsafe-accepted")'],{
        windowsHide:true,env:{...process.env,HTC_STABILIZATION_DATA_DIR:resolve('.test-data/stabilization'),[variable]:variable.includes('PRELOAD')||variable.includes('HTML')?resolve(link,'preload.cjs'):resolve(link,'missing-child')},
      }),/STABILIZATION_PATH_UNTRUSTED/);
    }
  } finally { await unlink(link);await rm(root,{recursive:true,force:true}); }
});

for(const scenario of [
  {name:'external-v4',all:false,addresses:'203.0.113.9',family:4,allowed:false},
  {name:'external-v6',all:false,addresses:'2001:db8::9',family:6,allowed:false},
  {name:'mixed-all',all:true,addresses:[{address:'127.0.0.1',family:4},{address:'2001:db8::9',family:6}],allowed:false},
  {name:'loopback-all',all:true,addresses:[{address:'127.0.0.1',family:4},{address:'::1',family:6}],allowed:true},
]) test(`S00 custom localhost lookup ${scenario.name} never dispatches an external TCP address`,async()=>{
  const result=await run(process.execPath,['-e',`
    const tcp=process.binding('tcp_wrap').TCP,attempts=[];
    for(const name of ['connect','connect6']) tcp.prototype[name]=function(_request,address,port){attempts.push({address,port});return -4078;};
    require(${JSON.stringify(guard)});
    const scenario=${JSON.stringify(scenario)};
    const socket=require('node:net').connect({host:'localhost',port:443,autoSelectFamily:scenario.all,
      lookup(_host,_options,callback){callback(null,scenario.addresses,scenario.family);}});
    socket.once('error',()=>console.log(JSON.stringify({attempts,blocked:globalThis.__stabilizationNetwork.blocked})));
  `],{windowsHide:true,env:{...process.env,NODE_OPTIONS:'',HTC_STABILIZATION_DATA_DIR:resolve('.test-data/stabilization')}});
  const output=JSON.parse(result.stdout);
  if(scenario.allowed) assert.ok(output.attempts.length>0);
  else { assert.deepEqual(output.attempts,[]);assert.ok(output.blocked.length>0); }
});

for(const folder of ['.test-data','artifacts']) test(`S00 launcher rejects synthetic ${folder} junction before creating output`,async()=>{
  const root=await mkdtemp(resolve('.test-data/guard-launcher-'));
  const fixtures=resolve(root,'tests/fixtures/stabilization'),target=resolve(root,'synthetic-target'),link=resolve(root,folder);
  await mkdir(fixtures,{recursive:true});await mkdir(resolve(root,'scripts'));await mkdir(target);
  await copyFile(resolve('scripts/stabilization-baseline.mjs'),resolve(root,'scripts/stabilization-baseline.mjs'));
  await copyFile(resolve('tests/fixtures/stabilization/trusted-path.cjs'),resolve(fixtures,'trusted-path.cjs'));
  await symlink(target,link,'junction');
  try {
    await assert.rejects(run(process.execPath,['scripts/stabilization-baseline.mjs','typecheck'],{cwd:root,windowsHide:true,env:{...process.env,NODE_OPTIONS:''}}),/STABILIZATION_PATH_UNTRUSTED/);
    assert.deepEqual(await readdir(target),[]);
  } finally { await unlink(link);await rm(root,{recursive:true,force:true}); }
});
