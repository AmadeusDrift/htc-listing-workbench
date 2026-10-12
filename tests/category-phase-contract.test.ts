import test from 'node:test';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
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
 const raw=decision('select',productType);const f=await fixture(t,{fetch:async()=>json({id:'category-contract',choices:[{finish_reason:'stop',message:{content:JSON.stringify(raw)}}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})});f.enable('deepseek');
 const request=f.service.decideCategory({productId:f.imageInput.productId,productRevision:f.imageInput.productRevision,phase:'select',keywords:['cloth'],candidates:[{name:'CLEANING_CLOTH',displayName:'Cloth'}]});
 if(productType==='CLEANING_CLOTH'){const result=await request;assert.equal(result.output.productType,productType);assert.deepEqual(result.output.keywords,[]);}
 else {await assert.rejects(request,isCode('OUTPUT_INVALID'));const call=f.service.listCalls()[0];assert.equal(call.errorCode,'OUTPUT_INVALID');const folder=join(f.directory,'ai-diagnostics');const name=readdirSync(folder).find(n=>n.includes(call.id))!;const diagnostic=JSON.parse(readFileSync(join(folder,name),'utf8'));assert.deepEqual(diagnostic.output,raw);assert.equal(diagnostic.rejectionReason,productType===null?'CATEGORY_SELECTION_MISSING':'CATEGORY_NOT_IN_CANDIDATES');}
 assert.equal(f.requests.length,1);
});
