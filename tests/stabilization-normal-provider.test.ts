import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const require=createRequire(import.meta.url),{createNormalProvider}=require(resolve('tests/fixtures/stabilization/pipeline-normal-provider.mjs'));
test('normal external chat fixtures use actual source reference IDs and fail closed on an unimplemented operation',async t=>{
  await mkdir(resolve('.test-data'),{recursive:true});const root=await mkdtemp(resolve('.test-data/s10-normal-provider-')),p=await createNormalProvider({directory:join(root,'server'),fixtureDirectory:join(root,'fixtures')});t.after(()=>p.close());
  const send=(payload:unknown)=>fetch(p.origin+'/normal/openrouter-chat',{method:'POST',headers:{authorization:'Bearer '+p.normalConfig.keys.openrouter,'content-type':'application/json'},body:JSON.stringify({model:'openai/gpt-6-luna',messages:[{role:'system',content:'fixture'},{role:'user',content:JSON.stringify(payload)}]})});
  const result=await send({operation:'source-image-consistency',referenceAssets:[{assetId:'01234567-89ab-4cde-8fab-0123456789ab'}]});assert.equal(result.status,200);const json=await result.json(),observation=JSON.parse(json.choices[0].message.content);assert.equal(observation.version,'source-image-consistency/v2');assert.equal(observation.assets[0].assetId,'01234567-89ab-4cde-8fab-0123456789ab');assert.equal('verdict' in observation,false);
  const unknown=await send({operation:'s10-unknown-operation'});assert.equal(unknown.status,422);assert.equal(p.ledger().filter((r:any)=>r.event==='request').length,2);
});
test('normal external provider answers source color, category and full-schema content while keeping original wire evidence',async t=>{
  await mkdir(resolve('.test-data'),{recursive:true});const root=await mkdtemp(resolve('.test-data/s10-normal-provider-')),p=await createNormalProvider({directory:join(root,'server'),fixtureDirectory:join(root,'fixtures')});t.after(()=>p.close());
  const send=async(payload:unknown)=>{const result=await fetch(p.origin+'/normal/openrouter-chat',{method:'POST',headers:{authorization:'Bearer '+p.normalConfig.keys.openrouter,'content-type':'application/json'},body:JSON.stringify({model:'openai/gpt-6-luna',messages:[{role:'system',content:'fixture'},{role:'user',content:JSON.stringify(payload)}]})});assert.equal(result.status,200);return JSON.parse((await result.json()).choices[0].message.content);};
  assert.deepEqual((await send({operation:'source-color',referenceImages:[{assetId:'source-original'}]})).referenceAssetIds,['source-original']);
  assert.deepEqual((await send({phase:'keywords'})).keywords,['drink coaster','coaster']);
  const content=await send({contract:'listing-full-schema/v1',fullSchema:{schema:{properties:{material:{type:'array',items:{properties:{value:{},marketplace_id:{}}}}}}},fields:[{name:'material'}],currentAttributes:{},marketplaceId:'ATVPDKIKX0DER',evidence:[{id:'original-material',meaning:'material'}]});assert.equal(content.candidates[0].nativeValue[0].value,'Silicone');assert.deepEqual(content.candidates[0].evidenceIds,['original-material']);
  const result=await fetch(p.origin+'/normal/decisions',{method:'POST',headers:{authorization:'Bearer '+p.normalConfig.keys.openrouter,'content-type':'application/json'},body:JSON.stringify({model:'openai/gpt-6-luna-decisions',questions:{category:{type:'choice',criteria:{DRINK_COASTER:'Drink coaster',$NO_SUITABLE:'None'}},review:{type:'choice',criteria:{clear:'clear',review:'review'}}}})});assert.equal(result.status,200);assert.equal((await result.json()).answers.category.choice,'DRINK_COASTER');assert.equal(p.ledger().filter((r:any)=>r.event==='request').length,4);
});
