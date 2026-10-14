import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
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
