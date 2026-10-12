import {sameSchemaValidation} from '../src/main/amazon/schema-compatibility.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures/listing-ai.ts';
const field={type:'array',items:{type:'object',properties:{value:{type:'string',enum:['barbecue-skewers'],enumNames:['Patio > Barbecue Skewers']}}}};
test('display-only enum name update keeps the same draft and completion context',async t=>{
 const f=await fixture(t,{item_type_keyword:field}),context=f.listing.currentContext(f.draft,f.product,f.amazon.executionTargetScope(f.draft.targetId).generation),newSchema=structuredClone(f.draft.schema);
 (newSchema.schema.properties as any).item_type_keyword.items.properties.value.enumNames=['Kitchen > Barbecue Skewers'];newSchema.checksum='new-display-checksum';
 f.amazon.getSchema=async()=>newSchema;
 const before=JSON.stringify(f.amazon.getDraft(f.draft.id));
 await assert.doesNotReject(()=>(f.listing as any).fresh(f.reference,context));
 assert.equal(JSON.stringify(f.amazon.getDraft(f.draft.id)),before);assert.equal(f.requests.length,0);
});
for(const change of ['enum','required','description','meta','version'] as const)test(`actual schema ${change} change still blocks old evidence`,async t=>{
 const f=await fixture(t,{item_type_keyword:field}),context=f.listing.currentContext(f.draft,f.product,f.amazon.executionTargetScope(f.draft.targetId).generation),newSchema=structuredClone(f.draft.schema);
 if(change==='enum')(newSchema.schema.properties as any).item_type_keyword.items.properties.value.enum=['different'];
 if(change==='required')newSchema.schema.required=['item_type_keyword'];
 if(change==='description')(newSchema.schema.properties as any).item_type_keyword.description='Materially different field guidance';
 if(change==='meta')newSchema.metaSchema.description='changed meta';
 if(change==='version')newSchema.version='new-schema-version';
 f.amazon.getSchema=async()=>newSchema;
 await assert.rejects(()=>(f.listing as any).fresh(f.reference,context),/字段规则或商品资料已更新/);assert.equal(f.requests.length,0);
});

test('enumNames inside literal data or a named property remains a real constraint',()=>{
 const left={schema:{const:{enum:['a'],enumNames:['a']}},metaSchema:{}};
 assert.equal(sameSchemaValidation(left,{schema:{const:{enum:['a'],enumNames:['b']}},metaSchema:{}}),false);
 assert.equal(sameSchemaValidation({schema:{properties:{enumNames:{const:'a'}}},metaSchema:{}},{schema:{properties:{enumNames:{const:'b'}}},metaSchema:{}}),false);
});
