import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {transformSync} from 'esbuild';
const {publicApi}=await import(new URL('../scripts/api-surface.mjs',import.meta.url).href) as {publicApi:string[]};
test('release capability allowlist exactly matches the frozen production preload bridge',()=>{
 const file=new URL('../src/main/preload.ts',import.meta.url),require=createRequire(file);let exposed:any,invocations=0;
 const electron={contextBridge:{exposeInMainWorld:(name:string,value:any)=>{assert.equal(name,'red');assert.equal(exposed,undefined);exposed=value;}},ipcRenderer:{invoke:()=>{invocations++;throw Error('No IPC calls during bridge declaration');}}};
 runInNewContext(transformSync(readFileSync(file,'utf8'),{loader:'ts',format:'cjs'}).code,{require:(name:string)=>name==='electron'?electron:require(name)});
 assert.ok(Object.isFrozen(exposed));assert.deepEqual(Object.keys(exposed).sort(),[...publicApi].sort());assert.equal(new Set(publicApi).size,publicApi.length);assert.equal(invocations,0);
});
