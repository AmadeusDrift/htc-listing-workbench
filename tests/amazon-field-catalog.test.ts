import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import type { JsonObject } from '../src/shared/amazon-contracts.ts';
import { realAmazonSchema } from './fixtures/amazon/schema-fixture.ts';
import { validateAttributes } from '../src/main/amazon/schema.ts';

const moduleUrl = new URL('../src/main/amazon/field-catalog.ts', import.meta.url);
async function catalog() { assert.ok(existsSync(moduleUrl), 'field-catalog module must exist'); return import(moduleUrl.href); }

test('field catalog uses actual properties and a bounded common semantic AI field set', async () => {
  const { buildFieldCatalog, AMAZON_AI_FIELDS } = await catalog(); const s = realAmazonSchema(); const cards = buildFieldCatalog(s);
  assert.equal(cards.length, 106); assert.equal(cards.some((card: {name:string}) => card.name === 'variation_theme'), false);
  assert.equal(cards.find((card: {name:string}) => card.name === 'item_name').requirement, 'required');
  assert.deepEqual(AMAZON_AI_FIELDS, ['item_name', 'bullet_point', 'product_description', 'generic_keyword', 'material', 'color', 'item_shape', 'care_instructions', 'operation_mode', 'included_components', 'special_feature', 'fabric_type', 'theme', 'subject_character', 'blade', 'target_audience', 'item_firmness_description', 'age_range_description', 'is_heat_sensitive', 'power_source_type', 'material_feature', 'is_expiration_dated_product', 'item_form','dental_floss_type','flavor','contains_liquid_contents','scent','specific_uses_for_product','surface_recommendation','closure','department','target_gender','ingredients']);
  for (const name of AMAZON_AI_FIELDS.filter(name=>Object.hasOwn(s.schema.properties as JsonObject,name))) assert.ok(cards.find((card: {name:string}) => card.name === name));
  assert.deepEqual(cards.find((card: {name:string}) => card.name === 'item_name').groups, [{key:'product_identity',title:'Product Identity'}]);
});

test('root required is separate from grouped conditional branches and optional fields', async () => {
  const { buildFieldCatalog } = await catalog(); const cards = buildFieldCatalog(realAmazonSchema());
  const fulfillment = cards.find((card: {name:string}) => card.name === 'fulfillment_availability');
  assert.equal(fulfillment.requirement, 'conditional');
  const origin = fulfillment.conditions.find((condition: {pointer:string}) => condition.pointer === '#/allOf/13/then');
  assert.equal(origin.kind, 'then'); assert.deepEqual(origin.required, ['fulfillment_availability']);
  assert.match(JSON.stringify(origin.condition), /is_value_stores_item/);
  const s = realAmazonSchema(); s.schema = {type:'object',properties:{a:{type:'string'},b:{type:'string'},c:{type:'string'}},required:['a'],anyOf:[{required:['b']},{required:['c']}]};
  const branches = buildFieldCatalog(s); assert.equal(branches.find((card: {name:string}) => card.name === 'b').requirement, 'conditional');
  assert.equal(branches.find((card: {name:string}) => card.name === 'c').conditions[0].pointer, '#/anyOf/1');
});

test('anyOf free text plus enum is suggestions while closed enums stay strict', async () => {
  const { buildFieldCatalog } = await catalog(); const cards = buildFieldCatalog(realAmazonSchema());
  const material = cards.find((card: {name:string}) => card.name === 'material');
  assert.equal(material.closedEnum, false); assert.ok(material.suggestedValues.includes('Cork')); assert.deepEqual(material.allowedValues, []);
  const shape = cards.find((card: {name:string}) => card.name === 'item_shape'); assert.equal(shape.closedEnum, false); assert.ok(shape.suggestedValues.includes('Round'));
  const flag = cards.find((card: {name:string}) => card.name === 'is_value_stores_item'); assert.equal(flag.closedEnum, true); assert.deepEqual(flag.allowedValues, [false,true]);
  const keyword = cards.find((card: {name:string}) => card.name === 'generic_keyword'); assert.equal(keyword.maxLength, 500); assert.equal(keyword.maxUtf8ByteLength, 2000);
});

test('internal refs retain limits and reject unresolved, external or circular refs safely', async () => {
  const { buildFieldCatalog } = await catalog(); const s = realAmazonSchema();
  s.schema = { type:'object', $defs:{text:{type:'string',minLength:2,maxLength:12}},properties:{value:{$ref:'#/$defs/text',maxLength:8}} };
  const card = buildFieldCatalog(s)[0]; assert.equal(card.minLength, 2); assert.equal(card.maxLength, 8);
  for (const ref of ['https://example.invalid/schema','#/$defs/missing','#/$defs/cycle']) {
    (s.schema.$defs as JsonObject).cycle = {$ref:'#/$defs/cycle'}; s.schema.properties = {value:{$ref:ref}};
    assert.throws(() => buildFieldCatalog(s), /引用|Schema|循环/);
  }
});

test('boolean union branches preserve open text and never turn a suggestion into a strict enum', async () => {
  const { buildFieldCatalog } = await catalog();
  for (const keyword of ['anyOf','oneOf']) {
    const snapshot = realAmazonSchema(); snapshot.metaSchema = {};
    snapshot.schema = {type:'object',properties:{material:{type:'string',[keyword]:[true,{enum:['Cotton'],maxLength:6}]}}};
    assert.deepEqual(validateAttributes(snapshot.schema,{material:'Silicone'}),[]);
    const card = buildFieldCatalog(snapshot)[0]; assert.equal(card.closedEnum,false,keyword); assert.deepEqual(card.allowedValues,[]);
    assert.equal(card.maxLength,undefined,`${keyword} true branch has no length bound`);
    if (keyword === 'oneOf') assert.equal(card.suggestedValues.includes('Cotton'),false,'Cotton matches both oneOf branches and is not a valid suggestion');
  }
});

test('false branches contribute no allowed union values and allOf retains empty intersections', async () => {
  const { buildFieldCatalog } = await catalog();
  for (const keyword of ['anyOf','oneOf']) {
    const snapshot = realAmazonSchema(); snapshot.metaSchema = {};
    snapshot.schema = {type:'object',properties:{material:{type:'string',[keyword]:[false,{enum:['Cotton'],maxLength:6}]}}};
    const card = buildFieldCatalog(snapshot)[0]; assert.equal(card.closedEnum,true); assert.deepEqual(card.allowedValues,['Cotton']); assert.equal(card.maxLength,6);
    assert.ok(validateAttributes(snapshot.schema,{material:'Silicone'}).length);
  }
  for (const branch of [true,false]) {
    const snapshot = realAmazonSchema(); snapshot.metaSchema = {};
    snapshot.schema = {type:'object',properties:{material:{type:'string',allOf:[branch,{enum:['Cotton'],maxLength:6}]}}};
    const card = buildFieldCatalog(snapshot)[0]; assert.equal(card.closedEnum,true); assert.deepEqual(card.allowedValues,branch ? ['Cotton'] : []);
    assert.equal(validateAttributes(snapshot.schema,{material:'Cotton'}).length === 0,branch);
  }
});

test('oneOf true branches preserve exclusivity while direct constraints remain binding', async () => {
  const { buildFieldCatalog } = await catalog(); const snapshot = realAmazonSchema(); snapshot.metaSchema = {};
  snapshot.schema = {type:'object',properties:{material:{type:'string',enum:['Cotton','Silicone'],oneOf:[true,{enum:['Cotton']}]}}};
  assert.deepEqual(validateAttributes(snapshot.schema,{material:'Silicone'}),[]); assert.ok(validateAttributes(snapshot.schema,{material:'Cotton'}).length);
  assert.deepEqual(buildFieldCatalog(snapshot)[0].allowedValues,['Silicone']);
  snapshot.schema.properties = {material:{type:'string',oneOf:[true,true,{enum:['Cotton']}]}};
  assert.ok(validateAttributes(snapshot.schema,{material:'Silicone'}).length);
  const impossible = buildFieldCatalog(snapshot)[0]; assert.equal(impossible.closedEnum,true); assert.deepEqual(impossible.allowedValues,[]);
});

test('open enum suggestions obey their complete leaf intersection instead of exposing incompatible examples',async()=>{
  const {buildFieldCatalog}=await catalog(),snapshot=realAmazonSchema();snapshot.metaSchema={};
  snapshot.schema={type:'object',properties:{material:{type:'string',anyOf:[{type:'string'},{enum:['Short','Much Too Long']}],allOf:[{maxLength:5}]}}};
  const card=buildFieldCatalog(snapshot)[0];assert.equal(card.closedEnum,false);assert.deepEqual(card.suggestedValues,['Short']);
});
