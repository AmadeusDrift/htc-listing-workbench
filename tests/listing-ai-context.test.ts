// Historical v0-v3 contract compatibility; new production behavior is covered by listing-full-schema tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyFixture as fixture } from './fixtures/listing-ai.ts';
import { buildListingContext } from './helpers/legacy-listing-context.ts';
import { assertListingEvidence, validateListingFieldsOutput } from '../src/main/listing-ai/validation.ts';
import { randomUUID } from 'node:crypto';
import { buildSalesRecipes } from '../src/main/sales-plans/recipes.ts';
import { defaultListingRules } from '../src/shared/listing-rules.ts';

test('mixed sales package color is aggregate evidence and cannot be mislabeled as one component color',async t=>{
  const f=await fixture(t),p=structuredClone(f.product);
  p.variants=['红色','蓝色'].map((color,i)=>({...p.variants[0],id:i?randomUUID():p.variants[0].id,sku:`SOURCE-${i}`,normalizedSpec:`颜色: ${color} / 尺寸: 小号`,originalSpec:`颜色: ${color} / 尺寸: 小号`,purchasePrice:'.1'}));
  const recipe=buildSalesRecipes(p,null,defaultListingRules()).find(r=>r.components.length>1)!;
  const draft={...f.draft,variantId:recipe.components[0].variantId,sku:'H2-261008-1-C',salesPlan:{namingGroupId:randomUUID(),sourceGroupKey:'manual:group',collectedAt:p.createdAt,collectionBasis:'first_import' as const,
    sku:'H2-261008-1-C',baseSku:'H2-261008-1',recipe,parentage:'NONE' as const,parentSku:null,variationTheme:null,relationReason:'Independent',familyResolved:true,namingChildKey:recipe.key}};
  const context=buildListingContext(draft,p,1);
  const colors=context.evidence.filter(e=>e.meaning==='color');
  const output=(value:string)=>validateListingFieldsOutput({kind:'amazon-fields',candidates:[{field:'color',items:[{value,evidenceIds:colors.map(e=>e.id),transformation:'compose'}]}],missing:[]});
  for(const value of ['Mixed colors','Multicolor'])assert.doesNotThrow(()=>assertListingEvidence(output(value),context));
  assert.throws(()=>assertListingEvidence(output('Red'),context));
});

test('source shape aliases and specific SKU pink/orange colors retain their correct meanings', async t => {
  const f = await fixture(t);
  for (const name of ['造型','外观造型']) {
    const context = buildListingContext(f.draft, {...f.product,facts:[...f.product.facts,{id:'shape',name,value:'青蛙',source:'1688',sourceRef:'',state:'source_confirmed'}]},1);
    assert.equal(context.evidence.find(e=>e.id==='shape')?.meaning,'item_shape');
  }
  for (const [spec,expected] of [['粉红色','Pink'],['橘色迷你粘毛器','Orange'],['黄色','Yellow']]) {
    const context=buildListingContext(f.draft,{...f.product,variants:[{...f.product.variants[0],normalizedSpec:spec}]},1);
    const evidence=context.evidence.find(e=>e.meaning==='color');assert.ok(evidence);
    assertListingEvidence(validateListingFieldsOutput({kind:'amazon-fields',candidates:[{field:'color',items:[{value:expected,evidenceIds:[evidence.id],transformation:'translate'}]}],missing:[]}),context);
    if(expected==='Pink') assert.throws(()=>assertListingEvidence(validateListingFieldsOutput({kind:'amazon-fields',candidates:[{field:'color',items:[{value:'Red',evidenceIds:[evidence.id],transformation:'translate'}]}],missing:[]}),context));
  }
});

test('common semantic repair fields carry their schema descriptions while commercial and compliance fields stay excluded', async t => {
  const f=await fixture(t), draft=structuredClone(f.draft), fields=['operation_mode','included_components','special_feature','fabric_type'];
  for(const name of [...fields,'price','compliance_document']) (draft.schema.schema.properties as any)[name]={...(draft.schema.schema.properties as any).material,title:name,description:`Description for ${name}`};
  const context=buildListingContext(draft,f.product,1);
  for(const name of fields) assert.equal((context.fields.find(f=>f.name===name) as any)?.description,`Description for ${name}`);
  assert.equal(context.fields.some(f=>['price','compliance_document'].includes(f.name)),false);
});

test('explicit fabric composition facts are usable as material evidence', async t => {
  const f=await fixture(t), draft=structuredClone(f.draft);
  (draft.schema.schema.properties as any).fabric_type=(draft.schema.schema.properties as any).material;
  const context=buildListingContext(draft,{...f.product,facts:[...f.product.facts,{id:'fabric',name:'面料成分',value:'100% cotton',source:'manual',sourceRef:'',state:'human_confirmed'}]},1);
  assert.equal(context.evidence.find(e=>e.id==='fabric')?.meaning,'material');
  assertListingEvidence(validateListingFieldsOutput({kind:'amazon-fields',candidates:[{field:'fabric_type',items:[{value:'100% Cotton',evidenceIds:['fabric'],transformation:'copy'}]}],missing:[]}),context);
});

test('confirmed 护理说明 is usable as care evidence', async t => {
  const f = await fixture(t);
  const product = { ...f.product, facts: [...f.product.facts, { id: 'care-fact', name: '护理说明', value: '手洗', source: 'manual' as const, sourceRef: '', state: 'human_confirmed' as const }] };
  const draft = structuredClone(f.draft);
  (draft.schema.schema.properties as any).care_instructions = (draft.schema.schema.properties as any).material;
  const context = buildListingContext(draft, product, 1);
  assert.equal(context.evidence.find(e => e.id === 'care-fact')?.meaning, 'care_instructions');
  assertListingEvidence(validateListingFieldsOutput({ kind: 'amazon-fields', candidates: [{ field: 'care_instructions', items: [{ value: 'Hand wash', evidenceIds: ['care-fact'], transformation: 'translate' }] }], missing: [] }), context);
});

test('multi-SKU AI context excludes global sizes and quantities while retaining selected SKU and common material', async t => {
  const f = await fixture(t);
  const names = ['商品长度', 'item_package_weight', '售卖件数', '商品数量', '包装数量', '包数', '尺寸'];
  const product = { ...f.product, facts: [...f.product.facts, ...names.map((name, i) => ({ id: `numeric-${i}`, name, value: '4', source: 'manual' as const, sourceRef: '', state: 'human_confirmed' as const }))], variants: [{ ...f.product.variants[0], normalizedSpec: 'L 20cm 8 pieces' }, { ...f.product.variants[0], id: 'other', sku: 'OTHER', normalizedSpec: 'S 10cm 4 pieces' }] };
  const context = buildListingContext(f.draft, product, 1);
  assert.ok(context.evidence.some(e => e.meaning === 'material'));
  assert.ok(context.evidence.some(e => e.source === 'selected_sku' && e.value === 'L 20cm 8 pieces'));
  assert.equal(context.evidence.filter(e => e.id.startsWith('numeric-')).length, 0);
  assert.throws(() => assertListingEvidence(validateListingFieldsOutput({ kind: 'amazon-fields', candidates: [{ field: 'item_name', items: [{ value: 'Silicone Coaster, 4-piece', evidenceIds: ['numeric-2'], transformation: 'translate' }] }], missing: [] }), context));
  const single = buildListingContext(f.draft, { ...product, variants: [product.variants[0]] }, 1);
  assert.ok(single.evidence.some(e => e.id === 'numeric-2'));
});

test('Miaoshou combined variant specifications cannot leak another SKU color into copy', async t => {
  const f = await fixture(t);
  const spec = '规格: 透明蓝黄【四格一体】（配4勺） / 颜色: 无规格';
  const product = { ...f.product, facts: [...f.product.facts, { id: 'all-specs', name: '规格', value: '透明蓝黄【四格一体】（配4勺）,透明青绿【四格一体】（配4勺）', source: 'manual' as const, sourceRef: '', state: 'source_confirmed' as const }], variants: [{ ...f.product.variants[0], normalizedSpec: spec }, { ...f.product.variants[0], id: 'other', sku: 'OTHER', normalizedSpec: '透明青绿' }] };
  const context = buildListingContext(f.draft, product, 1);
  assert.equal(context.evidence.some(e => e.id === 'all-specs'), false);
  const color = context.evidence.find(e => e.meaning === 'color');
  assert.equal(color?.value, 'Clear Blue-Yellow');
  assert.equal(color?.source, 'selected_sku');
  assertListingEvidence(validateListingFieldsOutput({ kind: 'amazon-fields', candidates: [{ field: 'color', items: [{ value: 'Clear Blue-Yellow', evidenceIds: [color!.id], transformation: 'copy' }] }], missing: [] }), context);
  assert.throws(() => assertListingEvidence(validateListingFieldsOutput({ kind: 'amazon-fields', candidates: [{ field: 'item_name', items: [{ value: 'Green Food Storage Container', evidenceIds: [color!.id], transformation: 'compose' }] }], missing: [] }), context));
});
