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

test('Haul platform delegation covers choices and nested missing values but keeps identity and structural guards',async()=>{
  const {isPlatformFieldIssue,canSendToPreview}=await import('../src/main/amazon/preview-validation.ts');
  const make=(code:string,message='choice：枚举问题',source:ListingIssue['source']='local'):ListingIssue=>({code,message,source,severity:'ERROR',category:'field',attributeNames:['choice'],autoFixable:false});
  for(const code of ['LOCAL_required','LOCAL_enum','LOCAL_oneOf','LOCAL_dependentRequired','LOCAL_maxLength'])assert.equal(isPlatformFieldIssue('haul',make(code)),true);
  for(const source of ['amazon','demo'] as const)assert.equal(isPlatformFieldIssue('haul',make('LOCAL_enum','choice',source)),false);
  for(const code of ['LOCAL_type','SCHEMA_UNSUPPORTED','SOURCE_CHANGED','FACT_SOURCE_CONFLICT','LOCAL_ASSET_URL'])assert.equal(isPlatformFieldIssue('haul',make(code)),false);
  for(const path of ['choice.0.marketplace_id','choice.0.language_tag','main_product_image_locator.0.media_location'])assert.equal(isPlatformFieldIssue('haul',make('LOCAL_required',path)),false);
  assert.equal(isPlatformFieldIssue('standard',make('LOCAL_enum')),false);
  const large:JsonObject={type:'object',properties:Object.fromEntries([...Array.from({length:110},(_,i)=>[`choice${i}`,{enum:['A']}]),['last',{type:'number'}]])};
  const attributes:JsonObject=Object.fromEntries([...Array.from({length:110},(_,i)=>[`choice${i}`,'B']),['last','broken']]);
  const localIssues=validateAttributes(large,attributes);assert.equal(localIssues.length,100);assert.ok(localIssues.every(i=>i.code==='LOCAL_enum'));
  assert.equal(canSendToPreview({listingProgram:'haul',schema:{schema:large,metaSchema:{}} as any,attributes,localIssues}),false,'truncated display diagnostics cannot hide structural error 111');
});

test('delegated local remaining text disappears without hiding same-message platform feedback',async()=>{
  const {nonDeferredImageIssues,withoutDeferredImageRemaining}=await import('../src/main/image-workflow/deferred-fields.ts');
  const local:ListingIssue={code:'LOCAL_enum',message:'choice：选项待平台核对',source:'local',severity:'ERROR',category:'field',attributeNames:['choice'],autoFixable:false};
  const draft={listingProgram:'haul',attributes:{},localIssues:[local],previewIssues:[]} as any;
  assert.deepEqual(nonDeferredImageIssues(draft),[]);assert.deepEqual(withoutDeferredImageRemaining(draft,[local.message]),[]);
  draft.previewIssues=[{...local,source:'amazon'}];assert.equal(nonDeferredImageIssues(draft).length,1);assert.deepEqual(withoutDeferredImageRemaining(draft,[local.message]),[local.message]);
});
