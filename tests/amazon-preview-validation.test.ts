import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import type { JsonObject, ListingIssue } from '../src/shared/amazon-contracts.ts';
import { validateAttributes } from '../src/main/amazon/schema.ts';

const moduleUrl=new URL('../src/main/amazon/preview-validation.ts',import.meta.url);
async function classifier() { assert.ok(existsSync(moduleUrl),'preview-validation classifier must exist'); return (await import(moduleUrl.href)).isMissingOnlyPreview; }
const field={type:'array',items:{type:'object',properties:{value:{type:'string'},marketplace_id:{type:'string'}},required:['value','marketplace_id'],additionalProperties:false}};
const schema:JsonObject={type:'object',properties:{material:field,care_instructions:field,trigger:{type:'boolean'}},required:['material'],additionalProperties:false};

test('only missing top-level business properties may pass the preflight classifier',async()=>{
  const check=await classifier();
  assert.equal(check(schema,{}, {},validateAttributes(schema,{})),true);
  const malformed:JsonObject[]=[{material:[{}]},{material:[{value:'Silicone'}]},{material:'Silicone'},{material:[{value:3,marketplace_id:'US'}]},{unknown:1}];
  for(const value of malformed)
    assert.equal(check(schema,value,{},validateAttributes(schema,value)),false,JSON.stringify(value));
  assert.equal(check(schema,{material:[{value:'Silicone',marketplace_id:'US'}]},{}),false,'a valid request is not a missing-only exception');
});

test('anyOf and oneOf zero-match summaries may accompany exclusively root business missing leaves',async()=>{
  const check=await classifier();
  for(const key of ['anyOf','oneOf']) {
    const conditional={...schema,required:[],[key]:[{required:['material']},{required:['care_instructions']}]};
    assert.equal(check(conditional,{},{}),true,key);
    assert.equal(check(conditional,{material:[{}]},{}),false,`${key} cannot hide a bad supplied wrapper`);
  }
  const overlapping={...schema,oneOf:[{},{}]};
  assert.equal(check(overlapping,{},{}),false,'multiple matching oneOf branches are not missing data');
});

test('conditional summaries keep missing business leaves but reject bad nested types and false schemas',async()=>{
  const check=await classifier();
  const conditional={...schema,required:[],allOf:[{if:{properties:{trigger:{const:true}},required:['trigger']},then:{required:['material']}}]};
  assert.equal(check(conditional,{trigger:true},{}),true);
  assert.equal(check(conditional,{trigger:true,material:[{value:3}]},{}),false);
  assert.equal(check({...conditional,allOf:[{if:true,then:false}]},{},{}),false);
  const refs={...schema,$defs:{missing:{required:['material']}},required:[],allOf:[{if:true,then:{$ref:'#/$defs/missing'}}]};
  assert.equal(check(refs,{},{}),true,'internal ref pointers retain root missing semantics');
});

test('non-schema source, program, copy and image guards cannot use the missing-only exception',async()=>{
  const check=await classifier();
  for(const code of ['SOURCE_CHANGED','HAUL_FORBIDDEN_ATTRIBUTE','POLICY_MAX_LENGTH','LOCAL_ASSET_URL']) {
    const issue:ListingIssue={code,message:'Guard failure',severity:'ERROR',attributeNames:[],category:'field',source:'local',autoFixable:false};
    assert.equal(check(schema,{}, {},[issue]),false,code);
  }
  assert.equal(check({...schema,required:['not_a_real_field']},{},{}),false);
  assert.equal(check({type:'object',unsupportedAssertion:true},{},{}),false);
});
