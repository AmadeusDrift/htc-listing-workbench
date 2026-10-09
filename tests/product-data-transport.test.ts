import test from 'node:test';
import assert from 'node:assert/strict';
import type { AmazonTarget } from '../src/shared/amazon-contracts.ts';
import { AmazonTransport } from '../src/main/amazon/transport.ts';

const target = {id:'test-shop',sellerId:'SELLER',marketplaceId:'ATVPDKIKX0DER',region:'na',mode:'live'} as AmazonTarget;
const sales = {sku:'HTC-NEW',interval:'2026-09-08T00:00:00Z--2026-10-07T10:00:00Z',amazonProgram:'AmazonHaul',granularity:'Day',granularityTimeZone:'UTC',marketplaceIds:target.marketplaceId};
function setup(reply: (url: URL) => Response | Promise<Response> = () => new Response('{"payload":[]}'), onSleep: () => void = () => {}, authReply?: () => Response) {
  let generation=1, clock=0, paused=0; const requests:{url:URL;at:number;method:string}[]=[];
  const transport = new AmazonTransport({active:()=>target,generation:()=>generation,credentials:()=>({name:'test',sellerId:target.sellerId,marketplaceId:target.marketplaceId,region:'na',locale:'en_US',clientId:'fake-client',clientSecret:'fake-secret',refreshToken:'fake-refresh'}),pause:()=>{paused++;},audit:()=>{},redact:<T>(v:T)=>v,remember:()=>{}}, {
    fetch:async(input,init)=>{const url=new URL(String(input));requests.push({url,at:clock,method:init?.method??'GET'});return url.hostname==='api.amazon.com'?(authReply?.() ?? new Response('{"access_token":"fake-token","token_type":"bearer","expires_in":3600}')):reply(url);},
    now:()=>clock,sleep:async ms=>{clock+=ms;onSleep();},random:()=>0,timeoutMs:100,
  });
  return {transport,requests,rotate:()=>{generation++;},get paused(){return paused;}};
}
test('product data requires explicit SKU scope and cannot read the historical entire shop',async()=>{
  const f=setup();
  await assert.rejects(()=>f.transport.readData(target,'sales',{...sales,sku:''}));
  await assert.rejects(()=>f.transport.readData(target,'inventory',{marketplaceIds:target.marketplaceId,details:'true'}));
  await assert.rejects(()=>f.transport.readData(target,'listings',{marketplaceIds:target.marketplaceId,pageSize:'20'}));
  assert.equal(f.requests.length,0);
});
test('product data only uses approved GET endpoints and rejects mismatched marketplace or extra controls',async()=>{
  const f=setup();
  await assert.rejects(()=>f.transport.readData(target,'sales',{...sales,marketplaceIds:'OTHER'}));
  await assert.rejects(()=>f.transport.readData(target,'sales',{...sales,mode:'SUBMIT'}));
  await f.transport.readData(target,'sales',sales);
  assert.equal(f.requests.at(-1)?.url.pathname,'/sales/v1/orderMetrics');
  assert.equal(f.requests.at(-1)?.method,'GET');assert.equal(f.requests.at(-1)?.url.searchParams.get('sku'),'HTC-NEW');
});
test('optional data permission failure does not disable the existing listing connection',async()=>{
  const f=setup(()=>new Response('{"errors":[{"code":"Unauthorized"}]}',{status:403}));
  await assert.rejects(()=>f.transport.readData(target,'sales',sales),error=>(error as {status:number}).status===403);
  assert.equal(f.paused,0); assert.equal(f.requests.length,2);
});
test('data reads serialize and obey the Sales default quota when Amazon omits rate headers',async()=>{
  const f=setup();
  await Promise.all([f.transport.readData(target,'sales',sales),f.transport.readData(target,'sales',{...sales,sku:'HTC-SECOND'})]);
  const reads=f.requests.filter(r=>r.url.pathname==='/sales/v1/orderMetrics');
  assert.equal(reads.length,2); assert.ok(reads[1].at-reads[0].at>=2100);
});
test('data reads reject results after credentials change mid-request',async()=>{
  let rotate=()=>{};
  const f=setup(()=>{rotate();return new Response('{"payload":[]}');});rotate=f.rotate;
  await assert.rejects(()=>f.transport.readData(target,'sales',sales),/配置已变化/);
});
test('data throttling preserves cooldown without pausing unrelated listing features',async()=>{
  const f=setup(()=>new Response('{}',{status:429,headers:{'retry-after':'60'}}));
  await assert.rejects(()=>f.transport.readData(target,'sales',sales),error=>(error as {status:number}).status===429);
  const calls=f.requests.length;
  await assert.rejects(()=>f.transport.readData(target,'sales',sales));
  assert.equal(f.requests.length,calls);assert.equal(f.paused,0);
});

test('stopping a data job during quota wait prevents the not-yet-sent request',async()=>{
  let stopped=false;
  const f=setup(undefined,()=>{stopped=true;});
  await f.transport.readData(target,'sales',sales);
  await assert.rejects(()=>f.transport.readData(target,'sales',sales,()=>{if(stopped)throw Error('stopped');}));
  assert.equal(f.requests.filter(r=>r.url.pathname==='/sales/v1/orderMetrics').length,1);
});

test('stopping a data job prevents another retry after a server error',async()=>{
  let stopped=false;
  const f=setup(()=>{stopped=true;return new Response('{}',{status:503});});
  await assert.rejects(()=>f.transport.readData(target,'sales',sales,()=>{if(stopped)throw Error('stopped');}));
  assert.equal(f.requests.filter(r=>r.url.pathname==='/sales/v1/orderMetrics').length,1);
  assert.equal(f.paused,0);
});

test('stopped queued data request is dropped before authentication or API read',async()=>{
  let release!:()=>void,started!:()=>void,stopped=false;
  const reading=new Promise<void>(resolve=>{started=resolve;});
  const firstResponse=new Promise<void>(resolve=>{release=resolve;});
  const f=setup(async()=>{started();await firstResponse;return new Response('{"payload":[]}');});
  const first=f.transport.readData(target,'sales',sales);
  const second=assert.rejects(()=>f.transport.readData(target,'sales',sales,()=>{if(stopped)throw Error('stopped');}));
  await reading;stopped=true;release();await Promise.all([first,second]);
  assert.equal(f.requests.length,2);
});

test('stopping while LWA is retrying stops further token requests as well',async()=>{
  let stopped=false;
  const f=setup(undefined,undefined,()=>{stopped=true;return new Response('{}',{status:503});});
  await assert.rejects(()=>f.transport.readData(target,'sales',sales,()=>{if(stopped)throw Error('stopped');}));
  assert.deepEqual(f.requests.map(request=>request.url.pathname),['/auth/o2/token']);
  assert.equal(f.paused,0);
});

test('late LWA authorization failures cannot pause newly saved credentials or a stopped job',async()=>{
  for(const status of [400,401,403,429]) for(const change of ['rotate','stop']) {
    let changed=()=>{},stopped=false;
    const f=setup(undefined,undefined,()=>{changed();return new Response('{}',{status,headers:{'retry-after':'60'}});});
    changed=()=>{if(change==='rotate')f.rotate();else stopped=true;};
    await assert.rejects(()=>f.transport.readData(target,'sales',sales,()=>{if(stopped)throw Error('stopped');}));
    assert.equal(f.paused,0,status+' '+change);assert.equal(f.requests.length,1);
  }
});
