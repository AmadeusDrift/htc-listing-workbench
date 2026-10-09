import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import type { JsonObject } from '../src/shared/amazon-contracts.ts';
import { realAmazonSchema } from './fixtures/amazon/schema-fixture.ts';

const moduleUrl = new URL('../src/main/amazon/field-mapping.ts', import.meta.url);
async function mapping() { assert.ok(existsSync(moduleUrl), 'field-mapping module must exist'); return import(moduleUrl.href); }
const market = 'ATVPDKIKX0DER';

test('candidate wrapper creates Amazon value arrays with resolved language and marketplace', async () => {
  const { wrapCandidateValues, validateFieldValues } = await mapping(); const s = realAmazonSchema();
  assert.deepEqual(wrapCandidateValues(s, market, 'material', ['Customblend']), [{value:'Customblend',language_tag:'en_US',marketplace_id:market}]);
  assert.deepEqual(validateFieldValues(s, market, 'material', ['Customblend']), []);
  assert.deepEqual(validateFieldValues(s, market, 'item_shape', ['Customblend']), []);
  assert.ok(validateFieldValues(s, market, 'is_value_stores_item', ['true']).length > 0);
  assert.throws(() => wrapCandidateValues(s, market, 'invented_field', ['unknown']), /字段|Schema/);
});

test('single field checks preserve root conditional dependencies without unrelated missing fields', async () => {
  const { validateFieldValues } = await mapping(); const s = realAmazonSchema();
  s.metaSchema = {}; s.schema = {$schema:'https://json-schema.org/draft/2019-09/schema',type:'object',$defs:{text:{type:'string'}},properties:{a:{$ref:'#/$defs/text'},b:{type:'string'},other:{type:'string'}},required:['other'],
    allOf:[{if:{required:['b'],properties:{b:{const:'trigger'}}},then:{properties:{a:{enum:['approved']}}}}]};
  assert.deepEqual(validateFieldValues(s,market,'a',['custom']), []);
  assert.ok(validateFieldValues(s,market,'a',['custom'],{b:'trigger'}).length > 0);
  assert.deepEqual(validateFieldValues(s,market,'a',['approved'],{b:'trigger'}), []);
});

test('unit conversion uses positive finite numeric measurements with explicit supported units', async () => {
  const { convertMeasurement } = await mapping();
  assert.deepEqual(convertMeasurement(10,'cm','length'),{status:'mapped',value:3.94,unit:'inches'});
  assert.deepEqual(convertMeasurement(100,'g','weight'),{status:'mapped',value:0.22,unit:'pounds'});
  assert.equal(convertMeasurement(1,'kg','weight').value,2.2);
  assert.equal(convertMeasurement(100,'mm','length').value,3.94);
  assert.equal(convertMeasurement(1,'m','length').value,39.37);
  assert.equal(convertMeasurement(2,'in','length').value,2); assert.equal(convertMeasurement(2,'lb','weight').value,2);
  assert.equal(convertMeasurement(1.234567891,'inches','length').value,1.234567891);
  assert.equal(convertMeasurement(0.123456789,'pounds','weight').value,0.123456789);
  assert.equal(convertMeasurement(0.001,'cm','length').status,'needs_input');
  assert.equal(convertMeasurement(1,'g','weight').status,'needs_input');
  for (const [value,unit] of [[0,'cm'],[-1,'g'],[Infinity,'g'],[NaN,'cm'],['abc','cm'],['10cm','cm'],[10,undefined],[10,'foot']]) assert.equal(convertMeasurement(value,unit,'length').status,'needs_input');
});

test('measurement mapping distinguishes item and package dimensions and maps Count as strict schema unit', async () => {
  const { mapMeasurementFields, wrapCandidateValues, validateFieldValues } = await mapping(); const s=realAmazonSchema();
  const result = mapMeasurementFields(s,market,{item:{length:{value:10,unit:'cm'},width:{value:10,unit:'cm'},height:{value:2,unit:'mm'},weight:{value:100,unit:'g'}},package:{length:{value:12,unit:'cm'},width:{value:12,unit:'cm'},height:{value:1,unit:'cm'},weight:{value:120,unit:'g'}},unitCount:4});
  assert.equal(result.needsInput.length,0);
  assert.equal((result.attributes.item_dimensions as JsonObject[])[0].length && ((result.attributes.item_dimensions as JsonObject[])[0].length as JsonObject).value,3.94);
  assert.equal(((result.attributes.item_package_dimensions as JsonObject[])[0].length as JsonObject).value,4.72);
  assert.deepEqual(result.attributes.unit_count, [{value:4,type:{value:'Count',language_tag:'en_US'},marketplace_id:market}]);
  assert.ok(validateFieldValues(s,market,'unit_count',[{value:4,type:{value:'Foot',language_tag:'en_US'}}]).length > 0);
  assert.deepEqual(wrapCandidateValues(s,market,'unit_count',[{value:4,type:{value:'Count',language_tag:'en_US'}}]), result.attributes.unit_count);
  const missing=mapMeasurementFields(s,market,{item:{length:{value:10},width:{value:10,unit:'cm'}}});
  assert.equal('item_dimensions' in missing.attributes,false); assert.ok(missing.needsInput.includes('item.length'));
});

test('copy policy enforces 75 title chars, exactly five bullets, 500 description and 200 UTF8 keywords plus stricter schema', async () => {
  const { validatePolicyOutputs, AMAZON_COPY_POLICY_VERSION } = await mapping(); const s=realAmazonSchema();
  assert.ok(AMAZON_COPY_POLICY_VERSION);
  const valid={item_name:['a'.repeat(75)],bullet_point:Array.from({length:5},(_,i)=>`Feature ${i}`),product_description:['a'.repeat(500)],generic_keyword:['a'.repeat(200)]};
  assert.deepEqual(validatePolicyOutputs(s,valid),[]);
  for (const patch of [{item_name:['a'.repeat(76)]},{bullet_point:['one']},{bullet_point:Array.from({length:5},()=> 'a'.repeat(501))},{product_description:['a'.repeat(501)]},{generic_keyword:['中'.repeat(67)]}]) assert.ok(validatePolicyOutputs(s,{...valid,...patch}).length > 0);
  ((((s.schema.properties as JsonObject).item_name as JsonObject).items as JsonObject).properties as JsonObject).value = {type:'string',maxLength:20};
  assert.ok(validatePolicyOutputs(s,valid).some((issue:{attributeNames:string[]})=>issue.attributeNames.includes('item_name')));
});

test('known scalar dimensions support decimal_value without assigning a height to thickness', async () => {
  const { mapMeasurementFields } = await mapping(); const schema = realAmazonSchema(); schema.metaSchema = {};
  const scalar = { type:'array', items:{type:'object',properties:{decimal_value:{type:'number',exclusiveMinimum:0},unit:{enum:['inches']},marketplace_id:{type:'string'}},required:['decimal_value','unit'],additionalProperties:false} };
  schema.schema = {type:'object',properties:{item_depth:scalar,item_thickness:scalar,unrelated_thickness:scalar}};
  const dimensions = mapMeasurementFields(schema,market,{item:{depth:{value:10,unit:'cm'},height:{value:5,unit:'cm'}}});
  assert.deepEqual(dimensions.attributes.item_depth,[{decimal_value:3.94,unit:'inches',marketplace_id:market}]);
  assert.equal(dimensions.attributes.item_thickness,undefined);
  const thickness = mapMeasurementFields(schema,market,{item:{thickness:{value:2,unit:'mm'}}});
  assert.deepEqual(thickness.attributes.item_thickness,[{decimal_value:.08,unit:'inches',marketplace_id:market}]);
  assert.equal(thickness.attributes.unrelated_thickness,undefined);
});
