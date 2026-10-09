import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProduct } from '../src/main/catalog/classification.ts';

const candidates = [{name:'KITCHEN_TOOL',displayName:'Kitchen tool'},{name:'OUTDOOR_TOOL',displayName:'Outdoor tool'}];
test('each product selects only a real candidate and ambiguity invokes a separate judgment', async () => {
  const phases: string[] = [];
  const result = await classifyProduct({ productId:'p',productRevision:1,targetId:'t' }, {
    keywords: async () => ({id:'k',output:{kind:'category-decision',phase:'keywords',keywords:['kitchen'],productType:null,reason:'厨房工具',ambiguous:false}}),
    search: () => candidates,
    fallback: async () => [],
    choose: async (_input, phase) => { phases.push(phase); return {id:phase,output:{kind:'category-decision',phase,keywords:['kitchen'],productType:'KITCHEN_TOOL',reason:'用于室内厨房备餐',ambiguous:phase==='select'}}; },
  });
  assert.equal(result.productType,'KITCHEN_TOOL'); assert.deepEqual(phases,['select','judge']); assert.equal(result.judged,true);
});
test('unavailable library uses official search and invented product types are rejected', async () => {
  let searches=0;
  const dependencies = {
    keywords: async () => ({id:'k',output:{kind:'category-decision' as const,phase:'keywords' as const,keywords:['kitchen'],productType:null,reason:'工具',ambiguous:false}}),
    search: () => [],
    fallback: async () => { searches++; return candidates; },
    choose: async () => ({id:'s',output:{kind:'category-decision' as const,phase:'select' as const,keywords:['kitchen'],productType:'MADE_UP',reason:'猜测',ambiguous:false}}),
  };
  await assert.rejects(classifyProduct({productId:'p',productRevision:1,targetId:'t'},dependencies), /候选/);
  assert.equal(searches,1);
});
