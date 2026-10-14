import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

async function adapter(){const path='../src/main/ai/adapters/openrouter-images.ts';assert.ok(existsSync(new URL(path,import.meta.url)),'OpenRouter images adapter must exist');return import(path);}
const png=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(13,8);png.write('IHDR',12);png.writeUInt32BE(256,16);png.writeUInt32BE(256,20);
test('OpenRouter images uses input_references and persists base64 before decode',async()=>{
  const {OpenRouterImageAdapter}=await adapter(),requests:any[]=[],receipts:any[]=[];
  const service=new OpenRouterImageAdapter({fetch:async(url:any,init:any)=>{requests.push({url,init});return new Response(JSON.stringify({id:'gen_image',data:[{b64_json:png.toString('base64'),media_type:'image/png'}],usage:{cost:.08}}));}});
  const result=await service.generate({apiKey:'openrouter-fixture-key',model:'openai/gpt-image-2.5-sunburst',prompt:'A product photo',size:'1024x1024',quality:'high',background:'opaque',references:[{mimeType:'image/png',bytes:png}]},new AbortController().signal,{onProviderReceipt:(r:any)=>receipts.push(r)});
  assert.equal(requests[0].url,'https://openrouter.ai/api/v1/images');
  const body=JSON.parse(requests[0].init.body);assert.equal(body.input_references[0].type,'image_url');assert.ok(body.input_references[0].image_url.url.startsWith('data:image/png;base64,'));assert.equal(body.images,undefined);assert.deepEqual(body.provider,{allow_fallbacks:true,require_parameters:true});
  assert.deepEqual(result.bytes,png);assert.equal(receipts[0].costUsd,.08);
});
test('invalid image bytes retain the original receipt without another generation',async()=>{
  const {OpenRouterImageAdapter}=await adapter();let calls=0;const receipts:any[]=[];
  const service=new OpenRouterImageAdapter({fetch:async()=>{calls++;return new Response(JSON.stringify({id:'gen_bad',data:[{b64_json:'aW52YWxpZA=='}]}));}});
  await assert.rejects(service.generate({apiKey:'openrouter-fixture-key',model:'openai/gpt-image-2.5-flare',prompt:'A product photo',size:'auto',quality:'auto',background:'auto',references:[]},new AbortController().signal,{onProviderReceipt:(r:any)=>receipts.push(r)}));
  assert.equal(calls,1);assert.equal(receipts.length,1);assert.equal(receipts[0].body.data[0].b64_json,'aW52YWxpZA==');
});
test('explicit image rejection is definitive while server failure remains unknown',async()=>{
  const {OpenRouterImageAdapter}=await adapter();
  for(const status of [401,402,429,500,504]){
    const receipts:any[]=[];let calls=0;
    const service=new OpenRouterImageAdapter({fetch:async()=>{calls++;return new Response(JSON.stringify({error:{message:'fixture'}}),{status});}});
    await assert.rejects(service.generate({apiKey:'openrouter-fixture-key',model:'openai/gpt-image-2.5-flare',prompt:'A product photo',size:'auto',quality:'auto',background:'auto',references:[]},new AbortController().signal,{onProviderReceipt:(r:any)=>receipts.push(r)}),(error:any)=>error.httpStatus===status&&error.definitive===(status<500));
    assert.equal(calls,1);assert.equal(receipts[0].status,status);
  }
});
