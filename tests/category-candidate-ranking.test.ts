import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProduct } from '../src/main/catalog/classification.ts';
import { categoryCandidateSnapshot } from '../src/main/ai/category-context.ts';
import { fixture } from './fixtures/ai-control.ts';
import type { CategoryDecision } from '../src/shared/category-ai-contracts.ts';
import { randomUUID } from 'node:crypto';
import { CategoryNoSuitableError } from '../src/main/catalog/classification.ts';
import { rankCategoryCandidates } from '../src/main/catalog/candidate-ranking.ts';
import { slowHttp } from './fixtures/stabilization/slow-http.ts';

const input={productId:'synthetic',productRevision:1,targetId:'store'};
const output=(phase:CategoryDecision['phase'],productType:string|null,keywords:string[]=[]):CategoryDecision=>({kind:'category-decision',phase,productType,keywords,reason:'Synthetic candidate evidence',ambiguous:false});
const exact={name:'PRECISION_HAND_TOOL',displayName:'Precision hand tool'};
const broad=Array.from({length:50},(_,i)=>({name:`BROAD_TOOL_${String(i).padStart(2,'0')}`,displayName:'General tool'}));

test('later exact candidate survives fifty earlier broad candidates',async()=>{
 let shortlist:string[]=[];
 await classifyProduct(input,{keywords:async()=>({id:'keywords',output:output('keywords',null,['tool','precision hand tool'])}),search:(_t,q)=>q==='tool'?broad:[exact],fallback:async()=>[],choose:async value=>{shortlist=value.candidates.map(c=>c.name);return{id:'select',output:output('select',value.candidates[0].name)};}});
 assert.equal(shortlist.length,50);assert.equal(shortlist[0],exact.name);
});

test('keyword order and duplicate discovery do not change tied order or real display names',async()=>{
 const snapshots:unknown[]=[];
 for(const keywords of [['alpha','beta'],['beta','alpha']])await classifyProduct(input,{keywords:async()=>({id:'keywords',output:output('keywords',null,keywords)}),search:(_t,q)=>[{name:q==='alpha'?'TYPE_A':'TYPE_B',displayName:q==='alpha'?'Alpha':'Beta'}],fallback:async()=>[],choose:async value=>{snapshots.push(value.candidates);return{id:'select',output:output('select',value.candidates[0].name)};}});
 assert.deepEqual(snapshots[0],snapshots[1]);
});

test('production full-library port reads once after keywords and ignores capped UI searches',async()=>{
 let read=0,keywordsDone=false,searches=0;let captured:unknown;
 const all=[...Array.from({length:80},(_,i)=>({name:`GENERAL_TOOL_${i}`,displayName:'General tool'})),exact];
 await classifyProduct(input,{keywords:async()=>{keywordsDone=true;return{id:'keywords',output:output('keywords',null,['tool','precision hand tool'])};},localCandidates:()=>{assert.ok(keywordsDone);read++;return all;},search:()=>{searches++;return broad;},fallback:async()=>{throw Error('unexpected expanded search');},choose:async value=>{captured=value.candidates;assert.equal(value.candidates[0].name,exact.name);return{id:'select',output:output('select',exact.name)};}});
 assert.equal(read,1);assert.equal(searches,0);assert.equal((captured as unknown[]).length,50);
});

test('recall evidence merges actual sources and keyword hits without inventing descriptions',()=>{
 const original=[{candidate:exact,keyword:'tool',source:'local' as const},{candidate:exact,keyword:'precision hand tool',source:'platform' as const},{candidate:exact,keyword:'tool',source:'local' as const}];
 const before=JSON.stringify(original),ranked=rankCategoryCandidates(original);
 assert.equal(JSON.stringify(original),before);assert.equal(ranked.length,1);assert.equal(ranked[0].displayName,exact.displayName);
 assert.deepEqual(ranked[0].recall,{sources:['local','platform'],keywords:['precision hand tool','tool'],score:100,basis:'exact-name'});
 assert.deepEqual(rankCategoryCandidates([...original].reverse()),ranked);
 assert.notEqual(categoryCandidateSnapshot([exact]),categoryCandidateSnapshot([{...exact,displayName:'Changed real label'}]));
});

test('legacy null, forged no-suitable snapshot or missing original call cannot mint a valid domain outcome',async()=>{
 for(const variant of ['legacy-null','foreign-snapshot','missing-call'] as const){
  const invalid={...output('select',null),...(variant==='legacy-null'?{}:{selection:{version:1 as const,outcome:'NO_SUITABLE' as const,candidateSnapshotSha256:variant==='foreign-snapshot'?'f'.repeat(64):categoryCandidateSnapshot([exact])}})};
  await assert.rejects(classifyProduct(input,{keywords:async()=>({id:'keywords',output:output('keywords',null,['tool'])}),search:()=>[exact],fallback:async()=>[],choose:async()=>({id:randomUUID(),...(variant==='missing-call'?{}:{callId:randomUUID()}),output:invalid})}),error=>error instanceof Error&&!(error instanceof CategoryNoSuitableError));
 }
});

for(const phase of ['select','judge'] as const)test(`${phase} explicit no-suitable stops before schema or draft without expansion`,async()=>{
 let schema=0,draft=0,fallback=0;const phases:string[]=[];
 const execute=async()=>{const classification=await classifyProduct(input,{keywords:async()=>({id:'keywords',output:output('keywords',null,['tool'])}),search:()=>[exact],fallback:async()=>{fallback++;return[];},choose:async(value,current)=>{phases.push(current);return{id:randomUUID(),callId:randomUUID(),output:current===phase?{...output(current,null),selection:{version:1,outcome:'NO_SUITABLE',candidateSnapshotSha256:categoryCandidateSnapshot(value.candidates)}}:{...output(current,exact.name),ambiguous:true}};}});schema++;draft++;return classification;};
 await assert.rejects(execute(),/无适用.*人工/);assert.equal(schema,0);assert.equal(draft,0);assert.equal(fallback,0);assert.deepEqual(phases,phase==='select'?['select']:['select','judge']);
});

test('foreign snapshot no-suitable is rejected and empty recall never calls a model selection',async()=>{
 let choices=0;
 const deps={keywords:async()=>({id:'keywords',output:output('keywords',null,['tool'])}),search:()=>[exact],fallback:async()=>[],choose:async()=>{choices++;return{id:'select',output:{...output('select',null),selection:{version:1 as const,outcome:'NO_SUITABLE' as const,candidateSnapshotSha256:'f'.repeat(64)}}};}};
 await assert.rejects(classifyProduct(input,deps),/候选/);assert.equal(choices,1);
 await assert.rejects(classifyProduct(input,{...deps,search:()=>[]}),/未返回/);assert.equal(choices,1);
});

for(const phase of ['select','judge'] as const)test(`actual ${phase} wire supports explicit no-suitable and retains the original response and usage`,async t=>{
 const envelope=phase==='select'?{id:'s04-no-suitable',answers:{category:{type:'choice',choice:'$NO_SUITABLE',probabilities:{$NO_SUITABLE:.9,PRECISION_HAND_TOOL:.1}},review:{type:'choice',choice:'clear'}},usage:{input_tokens:2,output_tokens:3,cost:.001}}:{id:'s04-no-suitable',choices:[{finish_reason:'stop',message:{content:JSON.stringify({...output('judge',null),selection:{version:1,outcome:'NO_SUITABLE',candidateSnapshotSha256:categoryCandidateSnapshot([exact])}})}}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5,cost:.001}};
 const http=await slowHttp({body:JSON.stringify(envelope)});t.after(()=>http.close());
 const f=await fixture(t,{fetch:async(_url,init)=>fetch(http.url,init)});
 f.service.saveConnection({id:'openrouter',apiKey:'s04-synthetic-key'});f.service.setEnabled({id:'openrouter',enabled:true});f.service.setEnabled({id:'openrouter-review',enabled:true});
 const result=await f.service.decideCategory({productId:f.product.id,productRevision:f.product.revision,phase,candidates:[exact],keywords:['tool']});
 assert.equal(result.output.selection?.outcome,'NO_SUITABLE');assert.equal(result.output.productType,null);assert.equal(result.output.ambiguous,false);assert.equal(f.requests.length,1);
 const request=JSON.parse(String(f.requests[0].options?.body));
 if(phase==='select')assert.ok(Object.hasOwn(request.questions.category.criteria,'$NO_SUITABLE'));
 else {const parts=request.messages[1].content,payload=JSON.parse(typeof parts==='string'?parts:parts[0].text);assert.equal(payload.candidateSnapshotSha256,categoryCandidateSnapshot([exact]));assert.match(request.messages[0].content,/NO_SUITABLE/);}
 const call=f.service.listCalls()[0];assert.equal(http.posts,1);assert.equal(call.status,'SUCCEEDED');assert.deepEqual((await f.service.readProviderReceipt(call.id) as {body:unknown}).body,envelope);assert.equal(f.service.getUsageSummary(phase==='select'?'openrouter':'openrouter-review').reportedTokens,5);
});
