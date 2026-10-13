import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { installCollectionIpc } from '../src/main/collection-ipc.ts';

test('W13 collection preparation stays retired even when an old bridge is supplied; history stays readable',async()=>{
  const handlers=new Map<string,Function>(),id=randomUUID(),receipt={productId:id,raw:'historical bytes'};let prepare=0,opened=0;
  const old={getStatus:()=>({state:'ready',connectionPrepared:true,activeConnections:1}),prepareConnection:()=>{prepare++;},getReceipt:()=>receipt};
  installCollectionIpc('fixture',(name,_count,handler)=>{handlers.set(name,handler);},old as any,async()=>{opened++;return '';});
  assert.equal(handlers.get('red:collection:status')!().state,'unavailable');
  await assert.rejects(Promise.resolve().then(()=>handlers.get('red:collection:prepare')!()));await assert.rejects(Promise.resolve().then(()=>handlers.get('red:collection:open-directory')!()));
  assert.deepEqual(handlers.get('red:collection:receipt')!(id),receipt);assert.equal(prepare,0);assert.equal(opened,0);
});
test('W13 main build and packaged app do not require native host or browser extension outputs',()=>{
  const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  assert.doesNotMatch(pkg.scripts.build,/native-host|extension|dotnet/);
  assert.doesNotMatch(readFileSync(new URL('../scripts/snapshot-release.mjs',import.meta.url),'utf8'),/csc\.exe|Microsoft\.NET|compilerSha256/);
  const main=readFileSync(new URL('../src/main/index.ts',import.meta.url),'utf8');assert.doesNotMatch(main,/new CollectionBridge|collection\.start\(/);
});

test('W13 official and old relay generation transports have no runtime source fallback',()=>{
  for(const name of ['adapter','tyai-adapter','gemini-adapter','relay-request','catalog'])assert.equal(existsSync(new URL(`../src/main/image-generation/${name}.ts`,import.meta.url)),false,name);
  const history=readFileSync(new URL('../src/main/image-generation/history-reader.ts',import.meta.url),'utf8');
  assert.doesNotMatch(history,/apiKey|method:\s*['"]POST|checkModel|generate\(/);
});
