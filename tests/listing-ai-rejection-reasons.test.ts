import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suggestListingFields } from '../src/main/ai/listing-adapters.ts';
import { chat } from './fixtures/listing-ai.ts';

test('partial field repair retains specific fixed rejection reasons and keeps other valid fields',async()=>{
  const variantId=randomUUID(),specId=`${variantId}:spec`;
  for(const [field,value,ids,reason] of [
    ['color','Red',[specId],/颜色.*依据/],
    ['item_name','Plain figurine',['unknown'],/引用.*不存在/],
    ['item_name','Figurine 99 cm',[specId],/尺寸|数值/],
    ['material','Cotton',['material'],/材质|翻译/],
    ['item_name','中文',[specId],/英文/],
    ['item_name','x'.repeat(76),[specId],/长度/],
  ] as const){
    const c:any={variantId,fields:[{name:field,closedEnum:false,allowedValues:[]},{name:'subject_character',closedEnum:false,allowedValues:[]}],evidence:[{id:specId,name:'Selected SKU specification',value:'蓝色青蛙，长度15.5 cm',meaning:'general',source:'selected_sku'},{id:'material',name:'材质',value:'硅胶',meaning:'material',source:'source_confirmed'}],repairRequest:{issues:[],currentValues:{}}};
    const raw={kind:'amazon-fields',candidates:[{field,items:[{value,evidenceIds:ids,transformation:'translate'}]},{field:'subject_character',items:[{value:'Frog',evidenceIds:[specId],transformation:'translate'}]}],missing:[]};
    const result=await suggestListingFields(c,'deepseek-flash',{apiKey:'test-only'},new AbortController().signal,{now:()=>new Date(),nonce:randomUUID,maxResponseBytes:200000,fetch:async()=>chat(raw)});
    assert.equal(result.output.candidates[0].field,'subject_character');assert.equal(result.output.candidates.length,1);
    assert.match(result.output.missing[0].reason,reason);assert.doesNotMatch(result.output.missing[0].reason,/test-only|unknown|99 cm/);
  }
});

test('partial field repair distinguishes a foreign SKU reference from a schema enum violation',async()=>{
  const variantId=randomUUID(),otherId=`${randomUUID()}:spec`;
  const c:any={variantId,fields:[{name:'color',closedEnum:false,allowedValues:[]}],evidence:[{id:otherId,name:'Selected SKU specification',value:'蓝色',meaning:'general',source:'selected_sku'}],repairRequest:{issues:[],currentValues:{}}};
  const raw={kind:'amazon-fields',candidates:[{field:'color',items:[{value:'Blue',evidenceIds:[otherId],transformation:'translate'}]}],missing:[]};
  const invoke=()=>suggestListingFields(c,'deepseek-flash',{apiKey:'test-only'},new AbortController().signal,{now:()=>new Date(),nonce:randomUUID,maxResponseBytes:200000,fetch:async()=>chat(raw)});
  assert.match((await invoke()).output.missing[0].reason,/其他 SKU/);
  c.evidence[0].id=`${variantId}:spec`;raw.candidates[0].items[0].evidenceIds=[c.evidence[0].id];c.fields[0].closedEnum=true;c.fields[0].allowedValues=['Green'];
  assert.match((await invoke()).output.missing[0].reason,/枚举/);
});
