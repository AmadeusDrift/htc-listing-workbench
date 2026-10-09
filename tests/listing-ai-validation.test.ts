import test from 'node:test';
import assert from 'node:assert/strict';
import { validateListingFieldsOutput, assertListingEvidence, validateListingReviewOutput, assertListingReview } from '../src/main/listing-ai/validation.ts';

const item = (value: string, evidenceIds = ['material-fact']) => ({ value, evidenceIds, transformation: 'translate' });
const output = (field = 'material', value = 'Silicone', evidenceIds?: string[]) => ({ kind: 'amazon-fields', candidates: [{ field, items: [item(value, evidenceIds)] }], missing: [] });
const context: any = { fields: [{ name: 'material' }, { name: 'color' }, { name: 'bullet_point' }, { name: 'item_name' }], evidence: [{ id: 'material-fact', name: '材质', value: '硅胶', meaning: 'material', source: 'human_confirmed' }] };

test('theme and subject character accept explicit subject evidence but reject unrelated facts', () => {
  for(const field of ['theme','subject_character']) {
    const c:any={fields:[{name:field}],evidence:[{id:'material-fact',name:field,value:'Frog',meaning:'general',source:'source_confirmed'}]};
    assertListingEvidence(validateListingFieldsOutput(output(field,'Frog')),c);
    assertListingEvidence(validateListingFieldsOutput(output(field,'Frog')),{...c,evidence:[{...c.evidence[0],name:'形状',meaning:'item_shape'}]});
    assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output(field,'Frog')),{...c,evidence:context.evidence}));
    assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output(field,'Frog')),{...c,evidence:[{...c.evidence[0],name:'包装数量',value:'1'}]}));
  }
});

test('fabric composition requires material evidence and cannot invent percentages or mark cloth not applicable', () => {
  const c:any={fields:[{name:'fabric_type'}],evidence:[{id:'material-fact',name:'材质',value:'PLA',meaning:'material',source:'source_confirmed'}]};
  assertListingEvidence(validateListingFieldsOutput(output('fabric_type','Not Applicable')),c);
  assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output('fabric_type','100% PLA')),c));
  assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output('fabric_type','Not Applicable')),{...c,evidence:[{...c.evidence[0],value:'棉'}]}));
  assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output('fabric_type','Not Applicable')),{...c,evidence:[{...c.evidence[0],value:'PLA and cotton'}]}));
  assertListingEvidence(validateListingFieldsOutput(output('fabric_type','100% Cotton')),{...c,evidence:[{...c.evidence[0],value:'100% cotton'}]});
  assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output('fabric_type','Nylon')),c));
  const mix={...c,evidence:[{...c.evidence[0],value:'60% cotton, 40% polyester'}]};
  for(const value of ['60% Nylon','40% Cotton, 60% Polyester']) assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output('fabric_type',value)),mix));
  assertListingEvidence(validateListingFieldsOutput(output('fabric_type','60% Cotton, 40% Polyester')),mix);
  for(const value of ['棉60%聚酯纤维40%','Cotton 60% Polyester 40%','Cotton 60%, 40% Polyester']){
    const suffix={...c,evidence:[{...c.evidence[0],value}]};
    assertListingEvidence(validateListingFieldsOutput(output('fabric_type','60% Cotton, 40% Polyester')),suffix);
    assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output('fabric_type','60% Cotton, 60% Polyester')),suffix));
  }
});

test('an explicit resin material supports non-textile fabric type without inventing a fiber composition',()=>{
  for(const value of ['合成树脂','树脂','Synthetic Resin','Resin']){
    const c:any={fields:[{name:'fabric_type'}],evidence:[{id:'material-fact',name:'材质',value,meaning:'material',source:'source_confirmed'}]};
    assert.doesNotThrow(()=>assertListingEvidence(validateListingFieldsOutput(output('fabric_type','Not Applicable')),c));
    assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output('fabric_type','100% Polyester')),c));
  }
  const c:any={fields:[{name:'fabric_type'}],evidence:[{id:'material-fact',name:'材质',value:'Resin and cotton',meaning:'material',source:'source_confirmed'}]};
  assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output('fabric_type','Not Applicable')),c));
  c.evidence[0].value='Resin';c.evidence[0].meaning='general';c.evidence[0].name='外观';
  assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output('fabric_type','Not Applicable')),c));
});

test('new semantic fields reject unrelated evidence and unsupported powered features or accessories', () => {
  for(const [field,value] of [['operation_mode','Automatic'],['included_components','Remote Control'],['special_feature','Bluetooth Enabled']]){
    const c:any={fields:[{name:field}],evidence:[{id:'material-fact',name:'材质',value:'PLA',meaning:'material',source:'source_confirmed'}]};
    assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output(field,value)),c));
  }
  const check=(field:string,value:string,name:string,fact:string,source='source_confirmed')=>assertListingEvidence(validateListingFieldsOutput(output(field,value)),{fields:[{name:field}],evidence:[{id:'material-fact',name,value:fact,meaning:'general',source}]} as any);
  check('operation_mode','Manual','类别','粘毛滚、除毛器');
  assert.throws(()=>check('operation_mode','Automatic','类别','粘毛滚、除毛器'));
  check('included_components','Decorative magnet','Selected SKU specification','青蛙（带磁铁）','selected_sku');
  check('included_components','Food storage container, 4 spoons','Selected SKU specification','四格一体（配4勺）','selected_sku');
  check('included_components','Food storage container, 4 spoons','Selected SKU specification','规格: 透明蓝黄【四格一体】（配4勺） / 颜色: 无规格','selected_sku');
  assert.throws(()=>check('included_components','Remote Control','Selected SKU specification','青蛙（带磁铁）','selected_sku'));
  check('special_feature','Moisture Resistant','功能','防潮');
  assert.throws(()=>check('special_feature','Bluetooth Enabled','功能','防潮'));
  assert.throws(()=>check('special_feature','Bluetooth Enabled','功能','不支持蓝牙'));
  check('special_feature','Bluetooth Enabled','功能','无线蓝牙');
  for(const [value,fact] of [['4 spoons','不含4勺'],['4 spoons','四格一体（不含4勺）'],['Spoon','无勺子']]) assert.throws(()=>check('included_components',value,'包装清单',fact));
});
test('listing candidates allow an evidenced translation but reject cross-field evidence and fabricated translations', () => {
  assertListingEvidence(validateListingFieldsOutput(output()), context);
  assert.throws(() => assertListingEvidence(validateListingFieldsOutput(output('color', 'Blue')), context));
  assert.throws(() => assertListingEvidence(validateListingFieldsOutput(output('material', 'Cotton')), context));
  assert.throws(() => assertListingEvidence(validateListingFieldsOutput(output('material', 'Silicone', ['missing'])), context));
});
test('listing output enforces allowed fields, English, counts, byte limits and exact keys', () => {
  for (const bad of [output('price', '5'), output('material', '硅胶'), output('item_name', 'x'.repeat(76)), output('generic_keyword', 'é'.repeat(101)), { ...output(), extra: 1 }, { ...output(), candidates: [output().candidates[0], output().candidates[0]] }, output('bullet_point', 'Only one bullet'), output('material', '')]) assert.throws(() => validateListingFieldsOutput(bad));
  assert.throws(() => assertListingEvidence(validateListingFieldsOutput(output('item_name', 'Dishwasher Safe Coaster')), context));
  for(const [value,fact] of [['FDA Certified','可用洗碗机'],['Dishwasher Safe','不可用洗碗机'],['Waterproof','手洗，不要放入洗碗机'],['Waterproof','不防水']]){
    const c={...context,evidence:[{id:'care',name:'清洗说明',value:fact,meaning:'care_instructions' as const,source:'human_confirmed' as const}]};
    assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output('item_name',value,['care'])),c));
  }
  assertListingEvidence(validateListingFieldsOutput(output('item_name','Do not put in the dishwasher',['care'])),{...context,evidence:[{id:'care',name:'清洗说明',value:'不可用洗碗机',meaning:'care_instructions',source:'human_confirmed'}]});
});
test('review requires full candidate coverage and evidence for each supported claim', () => {
  const candidate = validateListingFieldsOutput(output());
  const review: any = { kind: 'amazon-fields-review', verdict: 'PASS', checks: [{ field: 'material', index: 0, verdict: 'SUPPORTED', evidenceIds: ['material-fact'], reason: 'Translation of silicone.', claims: [{ text: 'Silicone', verdict: 'SUPPORTED', evidenceIds: ['material-fact'], reason: 'Translation.' }] }], issues: [] };
  assertListingReview(validateListingReviewOutput(review), candidate, context);
  assert.throws(() => assertListingReview(validateListingReviewOutput({ ...review, checks: [] }), candidate, context));
  assert.throws(() => assertListingReview(validateListingReviewOutput({ ...review, checks: [{ ...review.checks[0], evidenceIds: ['unknown'] }] }), candidate, context));
  assert.throws(() => validateListingReviewOutput({ ...review, checks: [{ ...review.checks[0], claims: [] }] }));
  const fabricated=validateListingFieldsOutput(output('item_name','Blue Silicone Coaster Set of 8'));
  assert.throws(()=>assertListingEvidence(fabricated,context));
  const partial=validateListingFieldsOutput(output('item_name','Silicone coaster for a desk'));
  const incomplete={...review,checks:[{...review.checks[0],field:'item_name'}]};
  assert.throws(()=>assertListingReview(validateListingReviewOutput(incomplete),partial,context));
});

test('restrained contextual copy is allowed without inventing measurements or guarantees', () => {
  assertListingEvidence(validateListingFieldsOutput(output('item_name','Easy-Clean Silicone Coaster')),context);
  for (const value of ['Silicone Coaster 8 inches','Silicone Coaster 50 grams','Guaranteed Unbreakable Coaster','FDA Approved Silicone Coaster']) {
    assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output('item_name',value)),context));
  }
  const bullets=['Silicone for everyday use.','An easy-clean silicone surface.','A silicone coaster for your table.','Simple silicone coaster design.','Keep a silicone coaster within reach.'];
  assertListingEvidence(validateListingFieldsOutput({kind:'amazon-fields',candidates:[{field:'bullet_point',items:bullets.map(value=>item(value))}],missing:[]}),context);
});

test('unqualified heat-resistance evidence cannot support a temperature or device compatibility', () => {
  const c={...context,evidence:[...context.evidence,{id:'general',name:'特点',value:'Heat resistant',meaning:'general',source:'human_confirmed'}]};
  for(const value of ['Silicone Coaster Heat Resistant to 500 degrees F','Compatible with iPhone 16','A 500 ml silicone container','Handles up to 200°C']) {
    assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output('item_name',value,['material-fact','general'])),c),value);
  }
  assertListingEvidence(validateListingFieldsOutput(output('item_name','Heat Resistant to 500 degrees F',['verified'])),{...context,evidence:[{id:'verified',name:'Temperature',value:'Heat resistant to 500°F',meaning:'general',source:'human_confirmed'}]});
  assertListingEvidence(validateListingFieldsOutput(output('item_name','Compatible with iPhone 16',['verified'])),{...context,evidence:[{id:'verified',name:'Compatible model',value:'iPhone 16',meaning:'general',source:'human_confirmed'}]});
  assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output('item_name','Compatible with iPhone 1',['verified'])),{...context,evidence:[{id:'verified',name:'Compatible model',value:'iPhone 16',meaning:'general',source:'human_confirmed'}]}));
  assert.throws(()=>assertListingEvidence(validateListingFieldsOutput(output('item_name','Operating temperature 20°C',['verified'])),{...context,evidence:[{id:'verified',name:'Temperature',value:'-20°C',meaning:'general',source:'human_confirmed'}]}));
});
