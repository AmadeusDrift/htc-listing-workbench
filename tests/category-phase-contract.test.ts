import test from 'node:test';
import {openDatabase} from '../src/main/database.ts';
import {readProviderReceipt} from '../src/main/ai/receipts.ts';
import assert from 'node:assert/strict';
import {validateCategoryDecision} from '../src/main/ai/category-adapter.ts';
import {classifyProduct} from '../src/main/catalog/classification.ts';
import {fixture,isCode,json} from './fixtures/ai-control.ts';
const decision=(phase:'keywords'|'select'|'judge',productType:string|null,keywords:string[]=[])=>({kind:'category-decision',phase,productType,keywords,reason:'Candidate matches the source product.',ambiguous:false});
for(const phase of ['select','judge'] as const)test(`${phase} retains a real category without redundant search keywords`,()=>{
 assert.deepEqual(validateCategoryDecision(decision(phase,'CLEANING_CLOTH')),decision(phase,'CLEANING_CLOTH'));
});
test('keyword generation remains required; null selection cannot be guessed from its prose',()=>{
 assert.throws(()=>validateCategoryDecision(decision('keywords',null)),isCode('OUTPUT_INVALID'));
 assert.throws(()=>validateCategoryDecision({...decision('select',null,['cloth']),reason:'Choose CLEANING_CLOTH'}),isCode('OUTPUT_INVALID'));
});
test('classification keeps original search terms when the selected output omits repeated terms',async()=>{
 const result=await classifyProduct({productId:'one',productRevision:1,targetId:'store'},{keywords:async()=>({id:'search',output:validateCategoryDecision(decision('keywords',null,['cloth']))}),search:()=>[{name:'CLEANING_CLOTH',displayName:'Cloth'}],fallback:async()=>[],choose:async()=>({id:'select',output:validateCategoryDecision(decision('select','CLEANING_CLOTH'))})});
 assert.deepEqual(result.keywords,['cloth']);assert.equal(result.productType,'CLEANING_CLOTH');
});
for(const productType of ['CLEANING_CLOTH','UNKNOWN_TYPE',null])test(`ledger accepts only actual candidate ${productType} with empty repeated keywords`,async t=>{
 const raw={id:'category-contract',answers:{category:{type:'choice',choice:productType},review:{type:'choice',choice:'clear'}},usage:{input_tokens:10,output_tokens:10}};const f=await fixture(t,{fetch:async()=>json(raw)});f.service.saveConnection({id:'openrouter',apiKey:'category-contract-offline-key'});f.service.setEnabled({id:'openrouter',enabled:true});
 const request=f.service.decideCategory({productId:f.imageInput.productId,productRevision:f.imageInput.productRevision,phase:'select',keywords:['cloth'],candidates:[{name:'CLEANING_CLOTH',displayName:'Cloth'}]});
 if(productType==='CLEANING_CLOTH'){const result=await request;assert.equal(result.output.productType,productType);assert.deepEqual(result.output.keywords,[]);}
 else {await assert.rejects(request,isCode('OUTPUT_INVALID'));const call=f.service.listCalls()[0];assert.equal(call.errorCode,'OUTPUT_INVALID');const db=openDatabase(f.directory);try{const receipt=await readProviderReceipt(db,f.directory,call.id);assert.deepEqual((receipt as {body:unknown}|null)?.body,raw);}finally{db.close();}}
 assert.equal(f.requests.length,1);
});
