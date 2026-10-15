import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {classifyProduct} from '../src/main/catalog/classification.ts';
import {categoryCandidateSnapshot} from '../src/main/ai/category-context.ts';
import {listingFingerprint} from '../src/main/json-fingerprint.ts';
import type {CategoryDecision} from '../src/shared/category-ai-contracts.ts';
import type {CategoryExpansionOperation,CategoryExpansionSnapshot} from '../src/shared/category-operation-contracts.ts';
import {categoryExpansionQuery,rankExpandedCategoryCandidates} from '../src/main/catalog/candidate-ranking.ts';
const input={productId:randomUUID(),productRevision:1,targetId:'synthetic-target'};
const local=Array.from({length:50},(_,i)=>({name:`BROAD_TOOL_${i}`,displayName:'General tool'}));
const novel={name:'NOVEL_PLATFORM_TYPE',displayName:'Actual platform label'};
const decision=(phase:'keywords'|'select'|'judge',type:string|null,keywords:string[]=[]):CategoryDecision=>({kind:'category-decision',phase,productType:type,keywords,reason:'Synthetic actual evidence',ambiguous:false});
function setup(options:{empty?:boolean;secondNone?:boolean;unknown?:boolean}={}){
 let claim:CategoryExpansionOperation|undefined;const counts={keywords:0,choose:0,reserve:0,permit:0,search:0,retain:0};
 const originalId=randomUUID(),originalCallId=randomUUID(),selectedId=randomUUID(),selectedCallId=randomUUID();
 const expansion={reserve:(value:{originalCallId:string;originalDecisionId:string;targetId:string;query:string})=>{counts.reserve++;claim??={version:1,operationId:randomUUID(),inputVersion:'a'.repeat(64),originalDecisionId:value.originalDecisionId,originalCallId:value.originalCallId,fromCandidateSnapshotSha256:categoryCandidateSnapshot(local),claimedAt:new Date().toISOString(),requestId:randomUUID(),targetId:value.targetId,query:value.query,requestSha256:listingFingerprint({method:'GET',targetId:value.targetId,query:value.query}),permittedAt:null,snapshot:null};return structuredClone(claim);},permit:()=>{assert.equal(claim!.permittedAt,null);counts.permit++;claim!.permittedAt=new Date().toISOString();return structuredClone(claim!);},search:async(value:CategoryExpansionOperation,beforeDispatch:()=>void)=>{assert.equal(value.requestId,claim!.requestId);beforeDispatch();counts.search++;if(options.unknown)throw Error('synthetic response unknown');return {requestId:value.requestId,candidates:options.empty?[]:[novel],receiptSha256:'b'.repeat(64),receivedAt:new Date().toISOString()};},retain:(_productId:string,snapshot:CategoryExpansionSnapshot)=>{counts.retain++;claim!.snapshot=structuredClone(snapshot);return structuredClone(snapshot);}};
 const deps={keywords:async()=>{counts.keywords++;return{id:randomUUID(),output:decision('keywords',null,['tool'])};},search:()=>local,localCandidates:()=>local,fallback:async()=>[],choose:async(value:{candidates:typeof local;expansion?:0|1},phase:'select'|'judge')=>{counts.choose++;if(value.expansion===1){assert.ok(value.candidates.some(c=>c.name===novel.name),'new platform result cannot be crowded out by fifty generic local matches');if(!options.secondNone)return{id:selectedId,callId:selectedCallId,output:decision(phase,novel.name)};}return{id:originalId,callId:originalCallId,output:{...decision(phase,null),selection:{version:1 as const,outcome:'NO_SUITABLE' as const,candidateSnapshotSha256:categoryCandidateSnapshot(value.candidates)}}};},expansion};
 return {deps,counts,getClaim:()=>claim};
}
test('one durable expansion adopts a new platform candidate even with zero literal match',async()=>{
 const f=setup();const result=await classifyProduct(input,f.deps);
 assert.equal(result.productType,novel.name);assert.equal(result.decisionIds.length,2);assert.deepEqual(f.counts,{keywords:1,choose:2,reserve:1,permit:1,search:1,retain:1});
 assert.ok(f.getClaim()?.snapshot?.evidence.find(e=>e.name===novel.name)?.sources.includes('platform'));
});
test('a saved expansion snapshot never permits or searches again',async()=>{
 const f=setup();await classifyProduct(input,f.deps);const identity=JSON.stringify(f.getClaim());await classifyProduct(input,f.deps);
 assert.equal(f.counts.search,1);assert.equal(f.counts.permit,1);assert.equal(f.counts.retain,1);assert.equal(JSON.stringify(f.getClaim()),identity);
});
for(const variant of ['empty','secondNone'] as const)test(`${variant} ends in manual confirmation without a second expansion`,async()=>{
 const f=setup({[variant]:true});await assert.rejects(classifyProduct(input,f.deps),/人工/);await assert.rejects(classifyProduct(input,f.deps),/人工/);assert.equal(f.counts.search,1);assert.equal(f.counts.permit,1);
});
test('permitted without a snapshot retains the original GET identity and never dispatches again',async()=>{
 const f=setup({unknown:true});await assert.rejects(classifyProduct(input,f.deps));const requestId=f.getClaim()?.requestId;
 await assert.rejects(classifyProduct(input,f.deps),error=>!!error&&typeof error==='object'&&(error as {requestId?:string}).requestId===requestId&&(error as {certainty?:string}).certainty==='SENT_UNKNOWN');assert.equal(f.counts.search,1);assert.equal(f.counts.permit,1);
});
test('expansion query and complete candidate evidence are deterministic and bounded',()=>{
 const keywords=['z'.repeat(100),'a'.repeat(100),'tool','tool'];assert.equal(categoryExpansionQuery(keywords),categoryExpansionQuery([...keywords].reverse()));assert.ok(categoryExpansionQuery(keywords).length<=200);
 const hits=[...local.map(candidate=>({candidate,keyword:'tool',source:'local' as const})),{candidate:novel,keyword:'',source:'platform' as const}];
 const ranked=rankExpandedCategoryCandidates(hits,local.map(candidate=>candidate.name));assert.equal(ranked.length,50);assert.ok(ranked.some(candidate=>candidate.name===novel.name));assert.deepEqual(ranked,rankExpandedCategoryCandidates([...hits].reverse(),local.map(candidate=>candidate.name)));assert.deepEqual(ranked.find(candidate=>candidate.name===novel.name)!.recall.keywords,[]);
 assert.deepEqual(rankExpandedCategoryCandidates(local.map(candidate=>({candidate,keyword:'tool',source:'platform' as const})),local.map(candidate=>candidate.name)),[]);
});
test('foreign search request identity is rejected before snapshot retention or expanded selection',async()=>{
 const f=setup(),search=f.deps.expansion.search;f.deps.expansion.search=async(claim,permit)=>({...await search(claim,permit),requestId:randomUUID()});
 await assert.rejects(classifyProduct(input,f.deps),/身份/);assert.equal(f.counts.search,1);assert.equal(f.counts.retain,0);assert.equal(f.counts.choose,1);
});
