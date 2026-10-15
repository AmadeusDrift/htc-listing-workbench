import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const {normalChatResponse,normalPng}=createRequire(import.meta.url)('./fixtures/stabilization/pipeline-normal-responses.mjs');
test('normal external review fixture requires real candidate bytes and rejects a mismatched digest',()=>{
 const pixels=normalPng(1),candidate={sha256:createHash('sha256').update(pixels).digest('hex'),width:1024,height:1024};
 const body=(sha256:string)=>Buffer.from(JSON.stringify({model:'openai/gpt-6-luna',messages:[{role:'system',content:'Synthetic review fixture'},{role:'user',content:[{type:'text',text:JSON.stringify({operation:'image-text-review',method:'candidate-vision/v1',candidate:{...candidate,sha256},plan:{textMode:'none',expectedText:[]}})},{type:'image_url',image_url:{url:'data:image/png;base64,'+pixels.toString('base64')}}]}]}));
 const result:any=normalChatResponse(body(candidate.sha256),'synthetic-direct');
 assert.equal(JSON.parse(result.json.choices[0].message.content).noTextVerified,true);
 assert.equal(normalChatResponse(body('a'.repeat(64)),'synthetic-mismatch').status,422);
});
