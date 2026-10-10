import test from 'node:test';
import assert from 'node:assert/strict';
import { realAmazonSchema, realParentAmazonSchema } from './fixtures/amazon/schema-fixture.ts';
import { defaultListingRules } from '../src/shared/listing-rules.ts';
import { applyBusinessRules } from '../src/main/amazon/business-rules.ts';
import type { ProductDetail, Variant } from '../src/shared/contracts.ts';
import type { AmazonTarget } from '../src/shared/amazon-contracts.ts';
import { validateFieldValues } from '../src/main/amazon/field-mapping.ts';
import { sourceAttributes } from '../src/main/amazon/demo.ts';
import type { Fact } from '../src/shared/contracts.ts';
import { validateAttributes } from '../src/main/amazon/schema.ts';
import type { JsonObject } from '../src/shared/amazon-contracts.ts';
import { assertListingHistory } from '../src/main/listing-ai/history.ts';
import type { AmazonDraft } from '../src/shared/amazon-contracts.ts';

const variant = { id: 'variant', sku: 'HTC-STABLE-SKU', originalSpec: '', normalizedSpec: '', purchasePrice: '2.40', sourcePurchasePrice: '2.40', sourceSpec: '', inventory: null } as Variant;
const product = { id: 'product', title: '方形硅胶杯垫', description: '', facts: [], variants: [variant] } as unknown as ProductDetail;
const target = { id: 'target', name: 'U8', marketplaceId: 'ATVPDKIKX0DER', mode: 'demo' } as AmazonTarget;
function run(extra: Partial<Parameters<typeof applyBusinessRules>[0]> = {}, rules = defaultListingRules()) {
  return applyBusinessRules({ product, variant, schema: realAmazonSchema(), target, attributes: {}, measurements: {}, costCny: 2.4, now: new Date('2026-10-07T02:00:00Z'), ...extra }, rules);
}

const legacyMeasurements:JsonObject={item_dimensions:[{length:{value:1.97,unit:'inches'},width:{value:1.97,unit:'inches'},height:{value:1.97,unit:'inches'},marketplace_id:target.marketplaceId}],item_package_dimensions:[{length:{value:1.97,unit:'inches'},width:{value:1.97,unit:'inches'},height:{value:1.97,unit:'inches'},marketplace_id:target.marketplaceId}],item_package_weight:[{value:.22,unit:'pounds',marketplace_id:target.marketplaceId}]};
const confirmedPackage = { package: { length: { value: 5, unit: 'cm' }, width: { value: 5, unit: 'cm' }, height: { value: 5, unit: 'cm' }, weight: { value: 100, unit: 'g' } } };

test('pricing decisions distinguish confirmed ROI rejection from default and unverified package attempts', () => {
  const confirmed = run({ costCny: 999, measurements: confirmedPackage }).report;
  assert.equal(confirmed.pricingDecision?.status, 'business_blocked');
  assert.equal(confirmed.pricingDecision?.code, 'ROI_MAX_PRICE');
  assert.deepEqual(confirmed.pricingDecision?.inputs, { costCny: 999, dimensionsInches: [1.97,1.97,1.97], weightPounds: .22 });
  assert.equal(confirmed.pricingDecision?.evidence.dimensions, 'confirmed_source');
  const defaults = run({ costCny: 999 });
  assert.equal(defaults.report.pricingDecision?.status, 'needs_input');
  assert.equal(defaults.report.pricingDecision?.code, 'PACKAGE_INPUT_UNCONFIRMED');
  assert.equal(defaults.report.pricingDecision?.quoteError, 'ROI_MAX_PRICE');
  const repeated = run({ costCny: 999, attributes: defaults.attributes, previousBusinessReport: defaults.report });
  assert.equal(repeated.report.pricingDecision?.evidence.dimensions, 'business_default');
  assert.equal(repeated.report.pricingDecision?.status, 'needs_input');
  const legacy = structuredClone(defaults.report); delete legacy.pricingDecision;
  const old = run({ costCny: 999, attributes: legacyMeasurements, previousBusinessReport: legacy });
  assert.equal(old.report.pricingDecision?.evidence.dimensions, 'unverified');
  assert.equal(old.report.pricingDecision?.status, 'needs_input');
  const manual = run({ costCny: 999, attributes: legacyMeasurements });
  assert.equal(manual.report.pricingDecision?.evidence.weight, 'unverified');
  assert.equal(manual.report.pricingDecision?.status, 'needs_input');
  const proven = run({ costCny: 999, measurements: confirmedPackage, attributes: defaults.attributes, previousBusinessReport: defaults.report });
  assert.equal(proven.report.pricingDecision?.status, 'business_blocked');
});

test('successful pricing stays identical with explicit evidence quality', () => {
  const defaults = run(), confirmed = run({ measurements: confirmedPackage });
  assert.deepEqual(defaults.report.quote, confirmed.report.quote);
  assert.equal(defaults.report.pricingDecision?.status, 'quoted');
  assert.equal(defaults.report.pricingDecision?.code, 'QUOTE_VALID');
  assert.equal(defaults.report.pricingDecision?.evidence.dimensions, 'business_default');
  assert.equal(confirmed.report.pricingDecision?.evidence.dimensions, 'confirmed_source');
});

test('blocked quantity facts and sales-recipe count mismatches cannot prove business rejection', () => {
  for (const facts of [
    [fact('售卖件数','5','conflicting')], [fact('unit_count','5','conflicting')],
    [fact('每套件数','5'),fact('unit_count','10')], [fact('每套件数','unknown')],
    [fact('商品数量','5','conflicting')], [fact('number_of_items','5','conflicting')],
  ]) {
    const result = run({ costCny: 999, measurements: confirmedPackage, product: { ...product, facts } });
    assert.equal(result.report.pricingDecision?.status, 'needs_input');
    assert.equal(result.report.pricingDecision?.code, 'SOURCE_QUANTITY_UNCONFIRMED');
    assert.equal(result.report.pricingDecision?.evidence.saleUnit, 'unconfirmed');
    assertListingHistory({ schema: realAmazonSchema(), marketplaceId: target.marketplaceId, businessRules: result.report } as AmazonDraft, new Map(), new Map());
  }
  const mismatch = run({ costCny: 999, measurements: confirmedPackage, saleUnit: { totalPieces: 1, totalCostCny: 999 }, packageMatchesSaleUnit: true,
    attributes: { number_of_items: [{ value: 4, marketplace_id: target.marketplaceId }] } });
  assert.equal(mismatch.report.pricingDecision?.status, 'needs_input');
  assert.equal(mismatch.report.pricingDecision?.code, 'SOURCE_QUANTITY_UNCONFIRMED');
  assert.equal(mismatch.report.pricingDecision?.evidence.saleUnit, 'unconfirmed');
  assert.equal(mismatch.report.pricingBasis?.saleUnitCostCny, 3996, 'the existing attempt math remains unchanged');
  const defaults = run({ measurements: confirmedPackage });
  const successful = run({ measurements: confirmedPackage, product: { ...product, facts: [fact('售卖件数','5','conflicting')] } });
  assert.deepEqual(successful.report.quote, defaults.report.quote);
  assert.equal(successful.report.pricingDecision?.status, 'quoted');
  assert.equal(successful.report.pricingDecision?.evidence.saleUnit, 'unconfirmed');
  assertListingHistory({ schema: realAmazonSchema(), marketplaceId: target.marketplaceId, businessRules: successful.report } as AmazonDraft, new Map(), new Map());
});

test('present malformed or ambiguous item counts stay unconfirmed instead of inheriting one piece', () => {
  const invalidCounts = [[], null, { value: 4 }, [{ value: 0 }], [{ value: -1 }], [{ value: 1.5 }], [{ value: '4' }], [{ value: 4 }, { value: 4 }]];
  for (const number_of_items of invalidCounts) {
    for (const saleUnit of [undefined, { totalPieces: 1, totalCostCny: 999 }]) {
      const result = run({ costCny: 999, measurements: confirmedPackage, saleUnit, packageMatchesSaleUnit: true, attributes: { number_of_items } });
      assert.equal(result.report.pricingDecision?.status, 'needs_input');
      assert.equal(result.report.pricingDecision?.code, 'SOURCE_QUANTITY_UNCONFIRMED');
      assert.equal(result.report.pricingDecision?.evidence.saleUnit, 'unconfirmed');
      assertListingHistory({ schema: realAmazonSchema(), marketplaceId: target.marketplaceId, businessRules: result.report } as AmazonDraft, new Map(), new Map());
    }
  }
  const confirmed = run({ costCny: 999, measurements: confirmedPackage, saleUnit: { totalPieces: 1, totalCostCny: 999 }, packageMatchesSaleUnit: true,
    attributes: { number_of_items: [{ value: 1, marketplace_id: target.marketplaceId }] } });
  assert.equal(confirmed.report.pricingDecision?.status, 'business_blocked');
});

test('overlapping quantity failures preserve generated history consistency and cause precedence', () => {
  const first = run({ costCny: .28 }), attributes = structuredClone(first.attributes);
  (attributes.number_of_items as any)[0].value = 5;
  delete attributes.purchasable_offer;
  const selected = { ...variant, originalSpec: '5 pc / 10 pc' };
  const legacy = structuredClone(first.report); delete legacy.pricingBasis;
  (legacy.fields.unit_count.value as any)[0].value = 5;
  for (const [previousBusinessReport, code, saleUnit] of [
    [first.report, 'SALE_QUANTITY_CHANGED', 'unconfirmed'],
    [legacy, 'LEGACY_QUANTITY_CONFLICT', 'conflicting'],
  ] as const) {
    const result = run({ costCny: .28, attributes, previousBusinessReport, variant: selected, product: { ...product, variants: [selected] } });
    assert.equal(result.report.pricingDecision?.code, code);
    assert.equal(result.report.pricingDecision?.status, 'needs_input');
    assert.equal(result.report.quote, null);
    const draft = JSON.parse(JSON.stringify({ schema: realAmazonSchema(), marketplaceId: target.marketplaceId, businessRules: result.report })) as AmazonDraft;
    assert.doesNotThrow(() => assertListingHistory(draft, new Map(), new Map()));
    assert.equal(result.report.pricingDecision?.evidence.saleUnit, saleUnit);
  }
});

test('quantity diagnostics tolerate unit-count-only schemas without requiring number-of-items', () => {
  const schema = realAmazonSchema(); delete (schema.schema.properties as any).number_of_items;
  for (const name of ['售卖件数','每套件数','number_of_items']) {
    const result = run({ schema, measurements: confirmedPackage, product: { ...product, facts: [fact(name, '5')] } });
    assert.equal(result.attributes.number_of_items, undefined);
    assert.ok(result.report.quote);
    assert.ok(Math.abs(result.report.quote!.upfrontCny - 3.7) < 1e-10);
    assert.equal(result.report.pricingDecision?.evidence.saleUnit, 'unconfirmed', 'missing field shape uses conservative diagnostic evidence');
    const draft = JSON.parse(JSON.stringify({ schema, marketplaceId: target.marketplaceId, businessRules: result.report })) as AmazonDraft;
    assert.doesNotThrow(() => assertListingHistory(draft, new Map(), new Map()));
  }
});

test('pricing causes separately identify missing costs, measurements, marketplace and source counts', () => {
  assert.equal(run({ costCny: null }).report.pricingDecision?.code, 'COST_CNY_UNCONFIRMED');
  const rules = defaultListingRules(); rules.product.dimensionFallback = false; rules.product.weightFallback = false;
  assert.equal(run({}, rules).report.pricingDecision?.code, 'PACKAGE_MEASUREMENTS_MISSING');
  assert.equal(run({ target: { ...target, marketplaceId: 'A1F83G8C2ARO7P' } }).report.pricingDecision?.code, 'MARKETPLACE_UNSUPPORTED');
  const conflicting = { ...variant, originalSpec: '5 pc / 10 pc' };
  assert.equal(run({ variant: conflicting, product: { ...product, variants: [conflicting] } }).report.pricingDecision?.code, 'SOURCE_QUANTITY_CONFLICT');
  const first = run({ costCny: .28 }), legacy = structuredClone(first.report);
  delete legacy.pricingBasis;
  (legacy.fields.unit_count.value as any)[0].value = 5;
  assert.equal(run({ costCny: .28, attributes: first.attributes, previousBusinessReport: legacy }).report.pricingDecision?.code, 'LEGACY_QUANTITY_CONFLICT');
  const changed = structuredClone(first.attributes); (changed.number_of_items as any)[0].value = 5;
  assert.equal(run({ costCny: .28, attributes: changed, previousBusinessReport: first.report }).report.pricingDecision?.code, 'SALE_QUANTITY_CHANGED');
});

test('bundle or mixed-sale package measurements need explicit matching scope', () => {
  const rules = defaultListingRules(); rules.pricing.margin = 10;
  const bundled = run({ costCny: .28, measurements: confirmedPackage }, rules);
  assert.equal(bundled.report.pricingDecision?.status, 'needs_input');
  assert.equal(bundled.report.pricingDecision?.code, 'PACKAGE_SCOPE_UNCONFIRMED');
  const saleUnit = { totalPieces: 10, totalCostCny: 999 };
  for (const packageMatchesSaleUnit of [false, undefined]) {
    const mixed = run({ costCny: 999, measurements: confirmedPackage, saleUnit, packageMatchesSaleUnit });
    assert.equal(mixed.report.pricingDecision?.code, 'PACKAGE_SCOPE_UNCONFIRMED');
  }
  assert.equal(run({ costCny: 999, measurements: confirmedPackage, saleUnit, packageMatchesSaleUnit: true }).report.pricingDecision?.status, 'business_blocked');
  const facts = [fact('包装长度','5 cm'),fact('包装宽度','5 cm'),fact('包装高度','5 cm'),fact('包装重量','100 g')];
  const mixedFacts = run({ costCny: 999, product: { ...product, facts }, saleUnit, packageMatchesSaleUnit: false });
  assert.equal(mixedFacts.report.pricingDecision?.status, 'needs_input');
});

test('source conflicts and edited source measurements cannot become reliable pricing rejections', () => {
  const source = run({ measurements: confirmedPackage });
  const edited = structuredClone(source.attributes); (edited.item_package_weight as any)[0].value = .3;
  assert.equal(run({ costCny: 999, measurements: confirmedPackage, attributes: edited }).report.pricingDecision?.status, 'needs_input');
  const conflicts = run({ costCny: 999, measurements: confirmedPackage, attributes: source.attributes, product: { ...product, facts: [fact('包装重量','100 g','conflicting')] } });
  assert.equal(conflicts.report.pricingDecision?.evidence.weight, 'conflicting');
  assert.equal(conflicts.report.pricingDecision?.status, 'needs_input');
  const brokenRules = defaultListingRules(); brokenRules.pricing.deliveryTiers = [];
  assert.equal(run({ measurements: confirmedPackage }, brokenRules).report.pricingDecision?.code, 'PRICING_SYSTEM_ERROR');
});
test('currency cent precision accepts 19.9 and rejects fractional cents', () => {
  const schema = realAmazonSchema();
  assert.equal(validateFieldValues(schema, target.marketplaceId, 'list_price', [{ value: 19.9, currency: 'USD' }]).length, 0);
  assert.ok(validateFieldValues(schema, target.marketplaceId, 'list_price', [{ value: 19.901, currency: 'USD' }]).some(issue => issue.code === 'LOCAL_multipleOf'));
});
test('seller price rules quote privately and never invent factual declarations', () => {
  const result = run();
  for(const field of ['brand','manufacturer','gpsr_safety_attestation','supplier_declared_dg_hz_regulation','item_package_dimensions','item_package_weight'])assert.equal(result.attributes[field],undefined,field);
  assert.equal((result.attributes.list_price as any)[0].value,19.9);
  assert.equal((result.attributes.purchasable_offer as any)[0].audience,'BZR');
  assert.deepEqual(result.report.pricingDecision?.inputs.dimensionsInches,[1.97,1.97,1.97]);
  assert.equal(result.report.pricingDecision?.inputs.weightPounds,.22);
  assert.equal(result.report.pricingDecision?.evidence.weight,'business_default');
  assert.ok(!Object.hasOwn(result.attributes,'fulfillment_availability'));
});

test('current SKU evidence, existing editable fields and inconsistent facts take precedence over defaults', () => {
  const result = run({ measurements: { item: { length: { value: 11, unit: 'cm' } } }, attributes: { brand: [{ value: 'Existing', marketplace_id: target.marketplaceId }] },
    product: { ...product, facts: [{ id: 'x', name: '是否需要电池', value: '是', state: 'source_confirmed', source: '1688', sourceRef: '' }] } });
  assert.equal(result.attributes.item_dimensions, undefined, 'incomplete source axes are not padded into actual attributes');
  assert.equal((result.attributes.brand as any)[0].value, 'Existing');
  assert.equal(result.attributes.batteries_required, undefined);
  assert.equal(result.attributes.required_product_compliance_certificate, undefined);
  assert.ok(result.report.notices.some(message => /batteries_required/.test(message)));
});
test('absent schema fields are omitted, missing procurement costs do not fabricate an offer, parent logistics stay empty', () => {
  const schema = realAmazonSchema(); delete (schema.schema.properties as any).list_price;
  const missing = run({ schema, costCny: null });
  assert.equal(missing.attributes.list_price, undefined); assert.equal(missing.attributes.purchasable_offer, undefined);
  assert.ok(missing.report.notices.some(message => /采购/.test(message)));
  const parent = run({ schema: { ...realAmazonSchema(), parentageLevel: 'PARENT' } });
  assert.equal(parent.attributes.item_package_weight, undefined); assert.equal(parent.attributes.purchasable_offer, undefined);
  const family=run({baseSku:'H2-261008-1',schema:{...realAmazonSchema(),parentageLevel:'PARENT'}});
  assert.equal((family.attributes.model_number as any)[0].value,'H2-261008-1');
});

const fact = (name: string, value: string, state: Fact['state'] = 'human_confirmed'): Fact => ({ id: `${name}:${value}`, name, value, state, source: 'manual', sourceRef: '' });

test('a chemical concern does not erase an independently confirmed no-battery fact',()=>{
  const schema=realAmazonSchema();
  (schema.schema.properties as JsonObject).batteries_required={type:'array',items:{type:'object',properties:{value:{type:'boolean'},marketplace_id:{type:'string'}},required:['value'],additionalProperties:false}};
  const cleaner=run({schema,product:{...product,title:'固体马桶清洁剂',facts:[fact('是否需要电池','否')]}});
  assert.equal((cleaner.attributes.batteries_required as JsonObject[])?.[0]?.value,false);
  assert.equal(cleaner.attributes.supplier_declared_dg_hz_regulation,undefined);
  const powered=run({schema,product:{...product,title:'充电清洁刷'}});
  assert.equal(powered.attributes.batteries_required,undefined);
  const batteryConflict=run({schema,product:{...product,title:'清洁剂',facts:[fact('是否需要电池','是','conflicting')]}});
  assert.equal(batteryConflict.attributes.batteries_required,undefined);
});

test('US import designation follows declared origin rather than a domestic supplier import label',()=>{
  const schema=realAmazonSchema();(schema.schema.properties as JsonObject).import_designation={type:'array',items:{type:'object',properties:{value:{type:'string'},language_tag:{type:'string'},marketplace_id:{type:'string'}},required:['value','language_tag'],additionalProperties:false}};
  const result=run({schema,product:{...product,facts:[fact('是否进口','否'),fact('原产国','CN')]}});
  assert.equal((result.attributes.import_designation as any)?.[0]?.value,'Imported');
  assert.match(result.report.fields.import_designation.reason,/原产国/);
  const manual=[{value:'Imported (China)',language_tag:'en_US',marketplace_id:target.marketplaceId}];
  assert.deepEqual(run({schema,attributes:{import_designation:manual}}).attributes.import_designation,manual);
  assert.equal(run({schema,attributes:{country_of_origin:[{value:'US',marketplace_id:target.marketplaceId}]}}).attributes.import_designation,undefined);
});

test('keychain size uses the selected original size and never invents units from a bare number',()=>{
  const schema=realAmazonSchema();schema.productType='KEYCHAIN';
  (schema.schema.properties as JsonObject).size={type:'array',items:{type:'object',properties:{value:{type:'string'},language_tag:{type:'string'},marketplace_id:{type:'string'}},required:['value'],additionalProperties:false}};
  const selected={...variant,originalSpec:'颜色: 企鹅 / 高度: 11厘米',sourceSpec:'颜色: 企鹅 / 高度: 11厘米'};
  const p={...product,variants:[selected,{...selected,id:'other',originalSpec:'颜色: 熊 / 高度: 20厘米',sourceSpec:'颜色: 熊 / 高度: 20厘米'}]};
  assert.equal((run({schema,product:p,variant:selected}).attributes.size as any)?.[0]?.value,'11 cm');
  const unknown={...selected,originalSpec:'高度: 11',sourceSpec:'高度: 11'};
  assert.equal(run({schema,product:p,variant:unknown}).attributes.size,undefined);
  const manual=[{value:'Small',marketplace_id:target.marketplaceId}];
  assert.deepEqual(run({schema,product:p,variant:selected,attributes:{size:manual}}).attributes.size,manual);
  const conflicting={...selected,sourceSpec:'高度: 20厘米'};
  assert.equal(run({schema,product:p,variant:conflicting}).attributes.size,undefined);
});

test('real figurine parent maps explicit declarations and passes complete schema without child offers or logistics', () => {
  const schema = realParentAmazonSchema(), market = target.marketplaceId;
  const text = (value: string) => [{ value, marketplace_id: market, language_tag: 'en_US' }];
  const attributes: JsonObject = {
    brand: text('Generic'), manufacturer: text('Fixture Maker'), part_number: [{ value: 'FIXTURE-PARENT', marketplace_id: market }],
    is_value_stores_item: [{ value: true, marketplace_id: market }], parentage_level: [{ value: 'parent', marketplace_id: market }],
    variation_theme: [{ name: 'COLOR' }], child_parent_sku_relationship: [{ child_relationship_type: 'variation', marketplace_id: market }],
    item_name: text('Articulated Frog Figurine'), product_description: text('Decorative articulated frog figurine for a desk or shelf.'),
    bullet_point: text('Decorative articulated frog figurine'),
  };
  const before = structuredClone(attributes);
  const result = run({ schema, attributes, product: { ...product, title: '关节可动青蛙摆件',facts:[fact('是否需要电池','false'),fact('原产国','CN'),fact('危险品法规','not_applicable')] } });
  for (const [field, value] of Object.entries({ batteries_required: false, country_of_origin: 'CN', supplier_declared_dg_hz_regulation: 'not_applicable' })) {
    assert.deepEqual(result.attributes[field], [{ value, marketplace_id: market }], field);
    assert.equal(result.report.fields[field],undefined, `${field} is explicit source evidence`);
  }
  assert.deepEqual(validateAttributes(schema.schema, result.attributes, schema.metaSchema), []);
  for (const field of ['purchasable_offer', 'list_price', 'condition_type', 'item_package_dimensions', 'item_package_weight', 'unit_count', 'number_of_items']) assert.equal(result.attributes[field], undefined, field);
  assert.deepEqual(attributes, before);
  const again = run({ schema, attributes: result.attributes, previousBusinessReport: result.report });
  assert.deepEqual(again.attributes, result.attributes);
  for (const field of ['batteries_required', 'country_of_origin', 'supplier_declared_dg_hz_regulation']) assert.deepEqual(again.report.fields[field], result.report.fields[field]);
});

test('parent declarations respect disabled defaults and explicit origin or battery facts', () => {
  const schema = realParentAmazonSchema(), rules = defaultListingRules(); rules.product.ordinaryDeclarations = false;
  const disabled = run({ schema }, rules);
  assert.equal(disabled.attributes.country_of_origin,undefined);
  assert.equal(disabled.attributes.batteries_required, undefined);
  assert.equal(disabled.attributes.supplier_declared_dg_hz_regulation, undefined);
  const explicit = run({ schema, product: { ...product, facts: [fact('原产国', 'Japan'), fact('是否需要电池', 'true')] } });
  assert.deepEqual(explicit.attributes.country_of_origin, [{ value: 'JP', marketplace_id: target.marketplaceId }]);
  assert.notEqual((explicit.attributes.batteries_required as JsonObject[] | undefined)?.[0]?.value, false);
  assert.equal(explicit.attributes.supplier_declared_dg_hz_regulation, undefined);
  const manualBattery = [{ value: true, marketplace_id: target.marketplaceId }];
  assert.deepEqual(run({ schema, attributes: { batteries_required: manualBattery } }).attributes.batteries_required, manualBattery);
});
test('Haul unbranded source labels use Generic without relabeling genuine brands or editing source facts', () => {
  for (const value of ['通用','无品牌','无牌','无','generic','No Brand','Unbranded','-','N/A']) {
    const selected = { ...product, facts: [fact('品牌', value, 'source_confirmed')] }, before = structuredClone(selected);
    const attributes = sourceAttributes(selected, variant, realAmazonSchema(), target, 'haul');
    assert.equal((attributes.brand as any)[0].value, 'Generic', value);
    assert.equal((run({ product: selected, attributes }).attributes.brand as any)[0].value, 'Generic');
    assert.equal((run({ product: selected }).attributes.brand as any)[0].value, 'Generic');
    const legacy = {brand:[{value,marketplace_id:target.marketplaceId,language_tag:'en_US'}]};
    assert.deepEqual(run({product:selected,attributes:legacy}).attributes.brand,legacy.brand,'existing stored values are preserved');
    assert.deepEqual(selected, before);
  }
  const branded = { ...product, facts: [fact('品牌', 'Actual Brand', 'source_confirmed')] };
  assert.equal((sourceAttributes(branded, variant, realAmazonSchema(), target, 'haul').brand as any)[0].value, 'Actual Brand');
});
test('partial confirmed measurements leave incomplete actual fields absent without losing facts or raw source metadata', () => {
  const selected = { ...product, facts: [fact('商品长度', '10 cm'), fact('包装重量', '100 g')] };
  const before = structuredClone(selected);
  const result = run({ product: selected });
  assert.equal(result.attributes.item_dimensions,undefined);
  assert.equal(result.report.pricingDecision?.evidence.dimensions,'business_default');
  assert.equal((result.attributes.item_package_weight as any)[0].value, .22);
  assert.deepEqual(selected, before);
});

test('manual partial attributes preserve native precision and leave missing axes absent', () => {
  const input = { item_package_dimensions: [{ length: { value: 1.234567891, unit: 'inches' }, marketplace_id: target.marketplaceId }] };
  const result = run({ attributes: input });
  assert.equal((result.attributes.item_package_dimensions as any)[0].length.value, 1.234567891);
  assert.equal((result.attributes.item_package_dimensions as any)[0].width,undefined);
  assert.deepEqual(result.report.pricingDecision?.inputs.dimensionsInches,[1.234567891,1.97,1.97]);
  assert.deepEqual(input.item_package_dimensions[0].length, { value: 1.234567891, unit: 'inches' });
});

test('confirmed alias conflicts and invalid manual measurements block matching fallback and receipt values', () => {
  for (const facts of [[fact('商品长度','10 cm'),fact('item_length','20 cm')], [fact('商品长度','0.001 cm')], [fact('商品长度','10')]]) {
    const result = run({ product: { ...product, facts }, measurements: { item: { length: { value: 5, unit: 'inches' } } } });
    assert.equal(result.attributes.item_dimensions, undefined);
    assert.ok(result.report.notices.some(value => /冲突|无效|单位|精度/.test(value)));
  }
});

test('complete source measurements use ROUND2 while existing manual attributes remain authoritative', () => {
  const selected = { ...product, facts: [fact('商品长度','10 cm'),fact('商品宽度','10 cm'),fact('商品高度','10 cm'),fact('包装重量','100 g')] };
  const attributes = sourceAttributes(selected, variant, realAmazonSchema(), target, 'haul');
  const result = run({ product: selected, attributes });
  assert.equal((result.attributes.item_dimensions as any)[0].length.value, 3.94);
  assert.equal((result.attributes.item_package_weight as any)[0].value, .22);
  const manual = [{ value: .345678912, unit: 'pounds', marketplace_id: target.marketplaceId }];
  assert.deepEqual(run({ product: selected, attributes: { item_package_weight: manual } }).attributes.item_package_weight, manual);
});

test('explicit English source care aliases are mapped without rewriting their meaning', () => {
  for (const name of ['清洗说明', '清洁方式', '洗涤说明']) {
    const selected = { ...product, facts: [fact(name, 'Hand wash with water', 'source_confirmed')] };
    const attributes = sourceAttributes(selected, variant, realAmazonSchema(), target, 'haul');
    assert.equal((attributes.care_instructions as any)?.[0]?.value, 'Hand wash with water');
  }
});

test('confirmed origin and declaration facts cannot become contradictory ordinary defaults', () => {
  const selected = { ...product, facts: [fact('原产国','Japan'),fact('supplier_declared_dg_hz_regulation','ghs'),fact('required_product_compliance_certificate','California Air Review Board (CARB)'),fact('GPSR安全声明','No')] };
  const result = run({ product: selected });
  assert.equal((result.attributes.country_of_origin as any)?.[0]?.value, 'JP');
  assert.notEqual((result.attributes.supplier_declared_dg_hz_regulation as any)?.[0]?.value, 'not_applicable');
  assert.notEqual((result.attributes.required_product_compliance_certificate as any)?.[0]?.value, 'Not Applicable');
  assert.notEqual((result.attributes.gpsr_safety_attestation as any)?.[0]?.value, true);
  const conflict = run({ product: { ...product, facts: [fact('supplier_declared_dg_hz_regulation','ghs'),fact('危险品法规','not_applicable')] } });
  assert.equal(conflict.attributes.supplier_declared_dg_hz_regulation, undefined);
  assert.ok(conflict.report.notices.some(value => /冲突/.test(value)));
});

test('existing counts suppress automatic rebundling even when pricing is unavailable', () => {
  const existing = run({ attributes: { number_of_items: [{ value: 4, marketplace_id: target.marketplaceId }] }, costCny: null });
  assert.equal((existing.attributes.unit_count as any)[0].value, 4);
  const unit = [{ value: 4, type: { value: 'Count', language_tag: 'en_US' }, marketplace_id: target.marketplaceId }];
  const result = run({ attributes: { unit_count: unit }, costCny: .28 });
  assert.deepEqual(result.attributes.unit_count, unit);
  assert.equal(result.report.bundleQuantity, 1, 'an existing sale-unit count is not a request to create another bundle');
  assert.ok(Math.abs(result.report.quote!.upfrontCny - 1.58) < 1e-10);
  assert.notEqual((result.attributes.number_of_items as any)?.[0]?.value, 10);
  assert.equal(result.attributes.number_of_items, undefined, 'unit_count has distinct semantics and must not manufacture a number_of_items claim');
});

test('explicit physical sale count aliases populate required item count as well as sale units', () => {
  for (const name of ['售卖件数', '每套件数']) {
    const selected = { ...product, facts: [fact(name, '3', 'source_confirmed')] };
    const schema = realAmazonSchema();
    const attributes = sourceAttributes(selected, variant, schema, target, 'haul');
    const result = run({ product: selected, schema, attributes });
    assert.equal((result.attributes.number_of_items as any)?.[0]?.value, 3, name);
    assert.equal((result.attributes.unit_count as any)?.[0]?.value, 3, name);
    assert.equal(result.report.bundleQuantity, 3);
    assert.equal(result.report.pricingBasis?.kind, 'source_sale_unit');
    assert.equal(result.report.pricingBasis?.quantity, 1, 'source pack cost must not be multiplied by its pieces');
  }
});

test('an explicit SKU pack claim is not silently multiplied into a new bundle', () => {
  const result = run({ variant: { ...variant, originalSpec: '4pcs' }, costCny: .28 });
  assert.equal(result.report.bundleQuantity, 4);
  assert.ok(Math.abs(result.report.quote!.upfrontCny - 1.58) < 1e-10);
});

test('explicit per-piece quotes price the selected pack automatically, missing units default to 1 pc', () => {
  const rules = defaultListingRules(); rules.pricing.bundleEnabled = false;
  const selected = run({ variant: { ...variant, originalSpec: '【10个装】单个价格' }, costCny: .38 }, rules);
  assert.equal(selected.report.bundleQuantity, 10);
  assert.equal(selected.report.pricingBasis?.quantity, 10);
  assert.equal(selected.report.pricingBasis?.saleUnitCostCny, 3.8);
  assert.ok(selected.report.quote);
  assert.equal((selected.attributes.number_of_items as any)[0].value, 10);
  const plain = run({ variant: { ...variant, originalSpec: '红色' } }, rules);
  assert.equal((plain.attributes.number_of_items as any)[0].value, 1);
});

test('default measurement provenance survives reapplying rules so images never treat it as real', () => {
  const historical={revision:0,fields:Object.fromEntries(Object.entries(legacyMeasurements).map(([field,value])=>[field,{value,reason:'业务默认；缺少实测'}])),notices:[],quote:null,bundleQuantity:1};
  const again = run({ attributes:legacyMeasurements, previousBusinessReport:historical });
  assert.deepEqual(again.attributes.item_dimensions,legacyMeasurements.item_dimensions);
  for (const field of ['item_dimensions','item_package_dimensions','item_package_weight']) {
    assert.match(again.report.fields[field]?.reason ?? '', /业务默认/);
  }
});

test('calculating a missing sale price preserves manually entered offer members', () => {
  const offer = [{ audience:'BZR', currency:'USD', marketplace_id:target.marketplaceId, start_at:[{value:'2026-10-08T00:00:00Z'}] }];
  const result = run({ attributes:{purchasable_offer:offer} });
  assert.deepEqual((result.attributes.purchasable_offer as any)[0].start_at,offer[0].start_at);
  assert.deepEqual(offer[0].start_at,[{value:'2026-10-08T00:00:00Z'}]);
});

test('approved depth shape uses defined axes and keeps unknown fields absent', () => {
  const schema = realAmazonSchema(), properties = schema.schema.properties as any;
  properties.item_depth_width_height = structuredClone(properties.item_dimensions); delete properties.item_dimensions;
  const item = properties.item_depth_width_height.items;
  item.properties.depth = item.properties.length; delete item.properties.length;
  item.required = item.required.map((name: string) => name === 'length' ? 'depth' : name);
  properties.unrelated_dimensions = structuredClone(properties.item_depth_width_height);
  const result = run({ schema, product: { ...product, facts: [fact('商品深度','10 cm'),fact('商品宽度','5 cm'),fact('商品高度','5 cm')] } });
  assert.equal((result.attributes.item_depth_width_height as any)[0].depth.value, 3.94);
  assert.equal((result.attributes.item_depth_width_height as any)[0].width.value, 1.97);
  assert.equal(result.attributes.unrelated_dimensions, undefined);
});

test('length-width-height category fields share the confirmed item and package dimension rules', () => {
  const schema = realAmazonSchema(), properties = schema.schema.properties as any;
  properties.item_length_width_height = structuredClone(properties.item_dimensions);
  delete properties.item_dimensions;
  const result = run({ schema, product: { ...product, facts: [fact('商品长度','10 cm'),fact('商品宽度','5 cm'),fact('商品高度','5 cm')] } });
  assert.equal((result.attributes.item_length_width_height as any)?.[0]?.length.value, 3.94);
  assert.equal((result.attributes.item_length_width_height as any)?.[0]?.width.value, 1.97);
  assert.equal((result.attributes.item_length_width_height as any)?.[0]?.height.value, 1.97);
  assert.equal(result.attributes.item_package_dimensions,undefined);
});

test('dimensions use schema-supported units when inches are unavailable', () => {
  const schema = realAmazonSchema(), properties = schema.schema.properties as any;
  for (const field of ['item_dimensions','item_length_width','item_package_dimensions']) for (const axis of ['length','width','height']) {
    const node = properties[field]?.items?.properties?.[axis]; if (node) node.properties.unit.enum = ['centimeters'];
  }
  const result = run({ schema,measurements:confirmedPackage });
  assert.deepEqual((result.attributes.item_package_dimensions as any)[0].length, { value: 5, unit: 'centimeters' });
});

test('USD list price is used when allowed among multiple currencies and omitted when disallowed', () => {
  const schema = realAmazonSchema(); (schema.schema.properties as any).list_price.items.properties.currency.enum = ['USD','CAD'];
  assert.equal((run({ schema }).attributes.list_price as any)[0].value, 19.9);
  (schema.schema.properties as any).list_price.items.properties.currency.enum = ['CAD'];
  assert.equal(run({ schema }).attributes.list_price, undefined);
});

test('a conflicting explicit depth cannot inherit the receipt length through the depth alias', () => {
  const schema = realAmazonSchema(), properties = schema.schema.properties as any;
  properties.item_depth_width_height = structuredClone(properties.item_dimensions); delete properties.item_dimensions;
  const item = properties.item_depth_width_height.items;
  item.properties.depth = item.properties.length; delete item.properties.length;
  item.required = item.required.map((name: string) => name === 'length' ? 'depth' : name);
  const selected = { ...product, facts: [fact('商品深度','10 cm'),fact('item_depth','20 cm')] };
  const measurements = { item: { length:{value:5,unit:'inches'},width:{value:5,unit:'inches'},height:{value:5,unit:'inches'} } };
  const attributes = sourceAttributes(selected, variant, schema, target, 'haul', measurements);
  assert.equal(attributes.item_depth_width_height, undefined);
  assert.equal(run({ schema, product:selected, measurements, attributes }).attributes.item_depth_width_height, undefined);
});

test('automatic bundle price basis survives repeated rules and a deleted offer without underpricing', () => {
  const first = run({costCny:.28});
  assert.equal(first.report.bundleQuantity,10);
  assert.ok(Math.abs(first.report.quote!.upfrontCny - 4.1) < 1e-10);
  const repeated = run({costCny:.28,attributes:first.attributes,previousBusinessReport:first.report});
  assert.equal(repeated.report.bundleQuantity,10);
  assert.equal(repeated.report.quote!.price,first.report.quote!.price);
  assert.equal(repeated.report.quote!.upfrontCny,first.report.quote!.upfrontCny);
  assert.deepEqual(repeated.attributes.purchasable_offer,first.attributes.purchasable_offer);
  const attributes=structuredClone(repeated.attributes); delete attributes.purchasable_offer;
  const repriced=run({costCny:.28,attributes,previousBusinessReport:repeated.report});
  assert.equal(repriced.report.quote!.price,first.report.quote!.price);
  assert.equal(repriced.report.quote!.upfrontCny,first.report.quote!.upfrontCny);
  assert.deepEqual(repriced.report.pricingBasis,{kind:'auto_bundle',sourceCostCny:.28,quantity:10,saleUnitCostCny:.28*10});
});

test('changed automatic bundle counts require renewed cost confirmation across repeated attempts', () => {
  const first=run({costCny:.28}),attributes=structuredClone(first.attributes);
  (attributes.number_of_items as any)[0].value=5; delete attributes.purchasable_offer;
  const changed=run({costCny:.28,attributes,previousBusinessReport:first.report});
  assert.equal(changed.report.quote,null); assert.equal(changed.attributes.purchasable_offer,undefined);
  assert.ok(changed.report.notices.some(value=>/组套.*成本|件数.*成本/.test(value)));
  const repeat=run({costCny:.28,attributes:changed.attributes,previousBusinessReport:changed.report});
  assert.equal(repeat.report.quote,null);assert.equal(repeat.attributes.purchasable_offer,undefined);
  const sourcePack=run({costCny:.28,attributes:{number_of_items:[{value:10,marketplace_id:target.marketplaceId}]}});
  assert.ok(Math.abs(sourcePack.report.quote!.upfrontCny-1.58)<1e-10,'confirmed supplier pack price is not multiplied by its number of pieces');
  assert.equal(sourcePack.report.pricingBasis?.kind,'source_sale_unit');
});

test('legacy generated bundle counts retain their cost multiplier', () => {
  const first=run({costCny:.28}), legacy=structuredClone(first.report), attributes=structuredClone(first.attributes);
  delete legacy.pricingBasis; delete attributes.purchasable_offer;
  const repriced=run({costCny:.28,attributes,previousBusinessReport:legacy});
  assert.equal(repriced.report.quote!.price,first.report.quote!.price);
  assert.equal(repriced.report.pricingBasis?.kind,'auto_bundle');
});

test('supplier packs retain their sale-unit cost basis when count fields are cleared', () => {
  const sourcePack=run({costCny:.28,attributes:{number_of_items:[{value:10,marketplace_id:target.marketplaceId}]}});
  const cleared=structuredClone(sourcePack.attributes);
  delete cleared.number_of_items; delete cleared.unit_count; delete cleared.purchasable_offer;
  const sourceRepriced=run({costCny:.28,attributes:cleared,previousBusinessReport:sourcePack.report});
  assert.ok(Math.abs(sourceRepriced.report.quote!.upfrontCny-1.58)<1e-10);
  assert.equal(sourceRepriced.report.pricingBasis?.kind,'source_sale_unit');
});

test('legacy unit_count-only generated bundles retain their multiplier after the offer is cleared', () => {
  const schema=realAmazonSchema(); delete (schema.schema.properties as any).number_of_items;
  const first=run({schema,costCny:.28}), legacy=structuredClone(first.report), attributes=structuredClone(first.attributes);
  assert.equal(attributes.number_of_items,undefined); assert.equal((attributes.unit_count as any)[0].value,10);
  delete legacy.pricingBasis; delete attributes.purchasable_offer;
  const repriced=run({schema,costCny:.28,attributes,previousBusinessReport:legacy});
  assert.equal(repriced.report.quote!.price,first.report.quote!.price);
  assert.equal(repriced.report.quote!.upfrontCny,first.report.quote!.upfrontCny);
  assert.equal(repriced.report.pricingBasis?.quantity,10);
  assert.equal(repriced.report.pricingBasis?.kind,'auto_bundle');
});

test('conflicting legacy generated counts block repricing across repeated attempts', () => {
  const first=run({costCny:.28}), legacy=structuredClone(first.report), attributes=structuredClone(first.attributes);
  delete legacy.pricingBasis; delete attributes.purchasable_offer;
  (legacy.fields.unit_count.value as any)[0].value=5;
  const blocked=run({costCny:.28,attributes,previousBusinessReport:legacy});
  assert.equal(blocked.report.quote,null); assert.equal(blocked.attributes.purchasable_offer,undefined);
  assert.ok(blocked.report.notices.some(value=>/组套.*冲突/.test(value)));
  const repeat=run({costCny:.28,attributes:blocked.attributes,previousBusinessReport:blocked.report});
  assert.equal(repeat.report.quote,null); assert.equal(repeat.attributes.purchasable_offer,undefined);
});

test('a legacy supplier pack with a derived unit_count does not become an automatic bundle', () => {
  const first=run({costCny:.28,attributes:{number_of_items:[{value:10,marketplace_id:target.marketplaceId}]}});
  const legacy=structuredClone(first.report), attributes=structuredClone(first.attributes);
  assert.ok(legacy.fields.unit_count); assert.equal(legacy.fields.number_of_items,undefined);
  delete legacy.pricingBasis; delete attributes.purchasable_offer;
  const repriced=run({costCny:.28,attributes,previousBusinessReport:legacy});
  assert.equal(repriced.report.quote!.upfrontCny,first.report.quote!.upfrontCny);
  assert.equal(repriced.report.pricingBasis?.kind,'source_sale_unit');
});
