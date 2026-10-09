import test from 'node:test';
import assert from 'node:assert/strict';
import { requestTokenReservation } from '../src/main/ai/usage.ts';
import { createHash, randomUUID } from 'node:crypto';
import { visionContent } from '../src/main/ai/vision.ts';

test('whole-set planning reserves its larger structured output budget without enlarging ordinary requests',()=>{
  const body={max_tokens:16384,messages:[{role:'user',content:[{type:'text',text:JSON.stringify({operation:'image-plan',setPolicy:'seven-product-v2'})}]}]};
  assert.ok(requestTokenReservation('deepseek',JSON.stringify(body))>16384+512);
  body.messages[0].content[0].text=JSON.stringify({operation:'image-plan',setPolicy:'seven-product-v2',slot:{index:1}});
  assert.throws(()=>requestTokenReservation('deepseek',JSON.stringify(body)));
});

test('vision reservations count image tokens without charging base64 as text tokens',()=>{
  const request={model:'deepseek-flash',max_tokens:4096,messages:[{role:'user',content:[{type:'text',text:'Identify this SKU.'},{type:'image_url',image_url:{url:`data:image/png;base64,${Buffer.alloc(64*1024).toString('base64')}`,detail:'original'}}]}]};
  const estimate=requestTokenReservation('deepseek',JSON.stringify(request));
  assert.ok(estimate>=4096+512+1024);
  assert.ok(estimate<7000,'Base64 transfer bytes are not image token usage');
  (request.messages[0].content[1] as any).image_url.url=`data:image/png;base64,${Buffer.alloc(128*1024).toString('base64')}`;
  assert.equal(requestTokenReservation('deepseek',JSON.stringify(request)),estimate);
});

test('text-only request reservations keep their previous conservative calculation',()=>{
  const body=JSON.stringify({max_tokens:4096,messages:[{role:'user',content:'Hello'}]});
  assert.equal(requestTokenReservation('deepseek',body),Buffer.byteLength(body)+512+4096);
});

test('vision images must retain their bytes, raster metadata and bounded reference count',()=>{
  const bytes=Buffer.alloc(33); Buffer.from('89504e470d0a1a0a','hex').copy(bytes); bytes.writeUInt32BE(13,8); bytes.write('IHDR',12); bytes.writeUInt32BE(256,16); bytes.writeUInt32BE(256,20);
  const image={assetId:randomUUID(),sha256:createHash('sha256').update(bytes).digest('hex'),mimeType:'image/png',width:256,height:256,bytes};
  assert.equal(visionContent({},[image]).length,2);
  for (const changed of [{sha256:'a'.repeat(64)},{mimeType:'image/jpeg'},{width:512},{bytes:Buffer.alloc(10*1024*1024+1)}]) assert.throws(()=>visionContent({},[{...image,...changed}]));
  assert.throws(()=>visionContent({},[])); assert.throws(()=>visionContent({},[image,image]));
  assert.throws(()=>visionContent({},Array.from({length:11},()=>({...image,assetId:randomUUID()}))));
});

test('a remote image URL cannot bypass the bounded inline-image token reservation',()=>{
  const body=JSON.stringify({max_tokens:4096,messages:[{role:'user',content:[{type:'image_url',image_url:{url:'https://example.test/source.png'}}]}]});
  assert.throws(()=>requestTokenReservation('deepseek',body));
});
