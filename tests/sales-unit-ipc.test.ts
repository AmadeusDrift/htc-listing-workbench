import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {createRequire} from 'node:module';
import {oldKit,taskKit} from './fixtures/mixed-kit.ts';
import {installAutomaticListingIpc} from '../src/main/automatic-listing-ipc.ts';

function amazonHandlers(service:any){
 const output=buildSync({entryPoints:['src/main/amazon-ipc.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['electron'],logLevel:'silent'}).outputFiles[0].text;
 const module={exports:{} as any},require=createRequire(import.meta.url),handlers=new Map<string,{count:number;call:(...args:unknown[])=>unknown}>();
 runInNewContext(output,{module,exports:module.exports,require:(id:string)=>id==='electron'?{dialog:{}}:require(id),Buffer,URL});
 module.exports.installAmazonIpc({},service,(name:string,count:number,call:(...args:unknown[])=>unknown)=>handlers.set(name,{count,call}),async()=>0);
 return handlers;
}
test('production standalone unit IPC accepts exact draft scope but never accepts a task owner override',async t=>{
 const f=await oldKit(t),handlers=amazonHandlers(f.amazon),preview=handlers.get('red:amazon:unit-preview')!,adopt=handlers.get('red:amazon:unit-adopt')!;
 assert.equal(preview.count,1);assert.equal(adopt.count,1);
 assert.throws(()=>preview.call({...f.ref,taskId:'00000000-0000-4000-a000-000000000000',platformPieces:1,basis:'Synthetic explicit scope'}),/字段|参数|无效/);
 const request={...f.ref,platformPieces:1,basis:'Synthetic complete kit sale'},proof=preview.call(request) as any;assert.equal(proof.canApply,true);
 const next=adopt.call({...request,token:proof.token,confirmed:true}) as any;assert.equal(next.sku,f.plan.sku);assert.equal(next.salesPlan.recipe.quantityVersion,2);assert.equal(f.requests.length,0);
});
test('production task IPC cannot be bypassed by standalone adoption and retains the canonical original row',async t=>{
 const f=await taskKit(t);try{
  const handlers=new Map<string,(...args:unknown[])=>unknown>();let confirmations=0;installAutomaticListingIpc(f.owner,(name,_count,call)=>handlers.set(name,call),{confirm:async()=>{confirmations++;return false;},audit:()=>{}});
  const standalone=amazonHandlers(f.amazon),request={taskId:f.task.id,taskRevision:f.task.revision,itemKey:f.task.items[0].key,platformPieces:1,basis:'Synthetic original task units'};
  const blocked=standalone.get('red:amazon:unit-preview')!.call({...f.ref,platformPieces:1,basis:request.basis}) as any;assert.equal(blocked.canApply,false);assert.throws(()=>standalone.get('red:amazon:unit-adopt')!.call({...f.ref,platformPieces:1,basis:request.basis,token:blocked.token,confirmed:true}),/任务/);
  assert.throws(()=>handlers.get('red:automatic-listing:unit-preview')!({...request,itemKey:f.task.items[0].key+'bad'}),/原任务行/);
  const proof=handlers.get('red:automatic-listing:unit-preview')!(request) as any;assert.equal(proof.unitPreview.canApply,true);
  const next=handlers.get('red:automatic-listing:unit-adopt')!({...request,token:proof.token,confirmed:true}) as any;assert.equal(next.status,'PAUSED');assert.equal(next.items[0].key,f.task.items[0].key);assert.equal(next.items[0].sku,f.plan.sku);assert.equal(confirmations,0);assert.equal(f.requests.length,0);
 }finally{await f.owner.close();}
});
