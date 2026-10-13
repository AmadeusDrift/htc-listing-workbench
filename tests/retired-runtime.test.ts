import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  const main=readFileSync(new URL('../src/main/index.ts',import.meta.url),'utf8');assert.doesNotMatch(main,/new CollectionBridge|collection\.start\(/);
});
