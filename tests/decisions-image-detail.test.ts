import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, json } from './fixtures/ai-control.ts';

test('Decisions category sends documented high detail while preserving original image bytes', async t => {
  let captured:any;
  const f=await fixture(t,{fetch:async (_url,init)=>{
    captured=JSON.parse(String(init?.body));
    const images=captured.state.filter((p:any)=>p?.type==='image_url');
    // Offline contract fixture matching the observed provider validation failure.
    if(images.some((p:any)=>!['auto','low','high'].includes(p.image_url.detail)))return json({error:{message:'Invalid input',code:400,metadata:{issues:[{path:['state',1,'image_url','detail'],message:'Invalid option: expected one of "auto"|"low"|"high"'}]}}},400);
    return json({answers:{category:{type:'choice',choice:'CLEANING_CLOTH'},review:{type:'choice',choice:'clear'}},usage:{input_tokens:23,output_tokens:0}});
  }});
  f.service.saveConnection({id:'openrouter',apiKey:'fixture-only'});
  f.service.setEnabled({id:'openrouter',enabled:true});
  const result=await f.service.decideCategory({productId:f.imageInput.productId,productRevision:f.imageInput.productRevision,phase:'select',candidates:[{name:'CLEANING_CLOTH',displayName:'Cleaning cloth'}]});
  assert.equal(result.output.productType,'CLEANING_CLOTH');
  const part=captured.state.find((p:any)=>p?.type==='image_url');
  assert.equal(part.image_url.detail,'high');
  const expected=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(expected);expected.writeUInt32BE(13,8);expected.write('IHDR',12);expected.writeUInt32BE(256,16);expected.writeUInt32BE(256,20);
  assert.deepEqual(Buffer.from(part.image_url.url.split(',')[1],'base64'),expected);
  assert.equal(f.requests.length,1);
});
