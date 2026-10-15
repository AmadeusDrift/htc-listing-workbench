import test from 'node:test';
import assert from 'node:assert/strict';
import {Server} from 'node:net';
import type {AddressInfo} from 'node:net';
import {slowHttp} from './fixtures/stabilization/slow-http.ts';

function forcePort(t:test.TestContext,all:boolean){
 const original=Server.prototype.listen,servers=new Set<Server>(),ports:number[]=[];let bindings=0;
 t.mock.method(Server.prototype,'listen',function(this:Server,...args:unknown[]){
  if(args[0]===0&&args[1]==='127.0.0.1'){
   servers.add(this);bindings++;this.once('listening',()=>ports.push((this.address() as AddressInfo).port));
   if(all||bindings===1)args[0]=4045;
  }
  return original.apply(this,args as Parameters<typeof original>);
 });
 t.after(async()=>{for(const server of servers)if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));});
 return {ports,servers,get bindings(){return bindings;}};
}

test('slow HTTP prepares past a fetch-blocked port and performs exactly the requested POST',async t=>{
 const bound=forcePort(t,false),http=await slowHttp({body:'{"ok":true}'});t.after(()=>http.close());
 assert.equal(bound.ports[0],4045);assert.ok(bound.ports.length>=2);assert.notEqual(new URL(http.url).port,'4045');
 assert.equal(http.posts,0);
 const response=await fetch(http.url,{method:'POST',body:'synthetic'});assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});assert.equal(http.posts,1);
 await http.close();assert.ok([...bound.servers].every(server=>!server.listening));
});

test('slow HTTP preparation has a finite port budget with no probe request or listening residue',async t=>{
 const bound=forcePort(t,true);let probes=0;t.mock.method(globalThis,'fetch',async()=>{probes++;throw Error('Preparation must not fetch');});
 await assert.rejects(slowHttp({body:'synthetic'}),/STABILIZATION_FETCH_SAFE_PORT_UNAVAILABLE/);
 assert.equal(bound.bindings,8);assert.deepEqual(bound.ports,Array(8).fill(4045));assert.equal(probes,0);assert.ok([...bound.servers].every(server=>!server.listening));
});
