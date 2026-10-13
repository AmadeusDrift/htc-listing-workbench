import { _electron } from 'playwright';
import assert from 'node:assert/strict';
import { writeFile, appendFile, mkdir } from 'node:fs/promises';
import { launchGuarded } from './release-runtime.mjs';
import { resolve, join, basename, sep } from 'node:path';
// Test-only wrapper: guard every application process before its entrypoint runs.
// Socket exception is restricted to the loopback FTP protocol fixture.
export const electron = { async launch(options) {
  const root = options.env?.RED_DATA_DIR;
  assert.ok(root && resolve(root).startsWith(resolve('.test-data') + sep), 'An isolated test data root is mandatory');
  await mkdir(root, { recursive: true });
  const bootstrap = join(root, 'core-network-bootstrap.cjs');
  await writeFile(bootstrap, `const net=require('node:net'),connect=net.Socket.prototype.connect,dns=require('node:dns'),lookup=dns.lookup;

require(${JSON.stringify(resolve('scripts/release-network-guard.cjs'))}).installNetworkGuard();
net.Socket.prototype.connect=function(...args){let a=args[0];if(Array.isArray(a))a=a[0];const host=typeof a==='object'?a.host:args[1];if(host==='127.0.0.1'||host==='::1')return connect.apply(this,args);globalThis.__releaseGuard.attempts.push('non-loopback socket');throw Error('External socket forbidden');};
dns.lookup=function(host,...args){if(host==='127.0.0.1'||host==='::1')return lookup.call(this,host,...args);globalThis.__releaseGuard.attempts.push('non-loopback dns');throw Error('External DNS forbidden');};
require('node:module').syncBuiltinESMExports();`);
  const env={...options.env}; for(const key of ['NODE_OPTIONS','RED_DEV_SERVER_URL','RED_COLLECTION_TEST_HOST'])delete env[key];
  const app=options.args?.length?await _electron.launch({...options,env,args:['-r',bootstrap,...options.args]}):await launchGuarded({executable:options.executablePath,dataRoot:root,guardPath:resolve('scripts/release-network-guard.cjs'),cwd:options.cwd});
  assert.equal(await app.evaluate(()=>globalThis.__releaseGuard.installedBeforeMain),true);
  const close=app.close.bind(app);app.close=async()=>{try{const state=await app.evaluate(()=>globalThis.__releaseGuard);await mkdir('artifacts/core-e2e-logs',{recursive:true});await appendFile(resolve('artifacts/core-e2e-logs/network.jsonl'),JSON.stringify({script:basename(process.argv[1]),at:new Date().toISOString(),dataRoot:root,externalRequests:0,guard:state})+'\n');if(state.attempts.length)process.exitCode=1;assert.deepEqual(state.attempts,[],'Unexpected network attempt in isolated core suite');}finally{await close();}};
  return app;
}};
