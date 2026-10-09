import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDetail } from '../src/main/miaoshou/normalize.ts';
import { detailFixture } from './helpers/miaoshou-fixture.ts';
import type { MiaoshouProduct } from '../src/shared/miaoshou-contracts.ts';

// Load optionally so an absent implementation fails an explicit feature assertion in the red phase.
const modulePath = '../src/shared/miaoshou-measurements.ts';
const implementation = await import(modulePath).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error;
});
function analyze(product: MiaoshouProduct, mapping?: unknown): any {
  assert.equal(typeof implementation.analyzeMiaoshouMeasurements, 'function', '文字参数提取应已接入');
  return implementation.analyzeMiaoshouMeasurements(product, mapping);
}
function product(attributes: { name: string; value: string }[] = [], description = ''): MiaoshouProduct {
  const raw = detailFixture();
  const p = raw.data.editCommonCollectBoxDetail;
  p.notes = ''; p.notesText = description; p.sourceAttrs = attributes;
  p.colorMap = {} as never; p.sizeMap = {} as never; p.saleProp3Map = {} as never;
  p.skuMap = { only: { itemNum: '', weight: null } } as never;
  return normalizeDetail(raw, '2026-10-07T08:00:00.000Z');
}
test('1688 missing length and weight units use cm/g, keep evidence and ROUND(2)', () => {
  const p = product([{ name: '尺寸', value: '7.5*7*4.2' }, { name: '净重', value: '120' }, { name: '包装毛重', value: '150' }]);
  const before = JSON.stringify(p), row = analyze(p).skus[0];
  assert.equal(row.values['item.length'].value, 2.95);
  assert.equal(row.values['item.width'].value, 2.76);
  assert.equal(row.values['item.height'].value, 1.65);
  assert.equal(row.values['item.weight'].value, 0.26);
  assert.equal(row.values['package.weight'].value, 0.33);
  assert.equal(row.values['item.weight'].sourceUnit, 'g');
  assert.equal(row.values['item.weight'].inferredUnit, true);
  assert.match(row.values['item.weight'].evidence, /净重.*120/);
  assert.equal(JSON.stringify(p), before);
});
test('explicit units override defaults and tuple units can be written once or per axis', () => {
  const row = analyze(product([{ name: '商品尺寸', value: '2in × 3in × 4in' }, { name: '包装尺寸', value: '100 × 80 × 60 mm' }, { name: '净重', value: '0.5 kg' }, { name: '毛重', value: '1.2 pounds' }])).skus[0];
  assert.equal(row.values['item.length'].value, 2);
  assert.equal(row.values['item.length'].inferredUnit, false);
  assert.equal(row.values['package.length'].value, 3.94);
  assert.equal(row.values['package.width'].value, 3.15);
  assert.equal(row.values['package.height'].value, 2.36);
  assert.equal(row.values['item.weight'].value, 1.1);
  assert.equal(row.values['package.weight'].value, 1.2);
});
test('defaults are limited to 1688 text; API weight keeps kg and does not silently become shipping weight', () => {
  const p = product([{ name: '长度', value: '11' }, { name: '重量', value: '120' }]);
  p.sources = [{ source: 'Other', sourceSite: 'other.example.com', sourceItemId: '1', sourceItemUrl: '' }];
  p.skus[0].weight = '0.5';
  const row = analyze(p).skus[0];
  assert.equal(row.values['item.length'], undefined);
  assert.equal(row.values['package.weight'], undefined);
  assert.ok(row.evidence.some((e: any) => e.origin === 'api' && e.sourceUnit === 'kg' && e.value === 1.1));
  assert.ok(row.evidence.some((e: any) => e.status === 'missing_unit'));
});
test('placeholder package sizes, zero and sub-cent precision are not promoted to usable values', () => {
  for (const values of [['0', '0', '0'], ['1', '1', '1'], ['10', '10', '10'], ['0', '10', '10']]) {
    const p = product(); [p.skus[0].packageLength, p.skus[0].packageWidth, p.skus[0].packageHeight] = values;
    const row = analyze(p).skus[0];
    assert.equal(row.values['package.length'], undefined);
    assert.ok(row.evidence.some((e: any) => e.status === 'suspect'));
  }
  const row = analyze(product([{ name: '净重', value: '1g' }])).skus[0];
  assert.equal(row.values['item.weight'], undefined);
  assert.ok(row.evidence.some((e: any) => /精度/.test(e.reason)));
});
test('text package evidence replaces placeholders while item, gross, net content and carton stay separate', () => {
  const p = product([{ name: '包装尺寸', value: '20*10*5' }, { name: '净含量', value: '400' }, { name: '整箱毛重', value: '12kg' }, { name: '单个净重', value: '120g' }]);
  Object.assign(p.skus[0], { packageLength: '1', packageWidth: '1', packageHeight: '1' });
  const row = analyze(p).skus[0];
  assert.equal(row.values['package.length'].value, 7.87);
  assert.equal(row.values['item.weight'].value, 0.26);
  assert.equal(row.values['package.weight'], undefined);
  assert.equal(row.values['content.weight'].value, 0.88);
  assert.equal(row.values['carton.weight'].value, 26.46);
});
test('source key resolves variant-specific text even when the supplier axis labels are swapped', () => {
  const p = product([{ name: '颜色', value: '小号12厘米长青蛙,大号21厘米长青蛙' }]);
  p.dimensions = [
    { id: 'color', name: '尺寸', values: [{ id: 'red', name: '红色', imageUrls: [] }] },
    { id: 'size', name: '颜色', values: [{ id: 'small', name: '小号12厘米长青蛙', imageUrls: [] }, { id: 'large', name: '大号21厘米长青蛙', imageUrls: [] }] },
  ];
  p.skus = [';red;small;', ';red;large;'].map(key => ({ ...p.skus[0], key }));
  const report = analyze(p);
  assert.equal(report.skus[0].values['item.length'].value, 4.72);
  assert.equal(report.skus[1].values['item.length'].value, 8.27);
  assert.equal(report.skus[0].values['item.height'], undefined);
  // An opaque SKU must not inherit every option (or the first option) from a multi-value attribute.
  p.skus = [{ ...p.skus[0], key: 'opaque' }];
  assert.equal(analyze(p).skus[0].values['item.length'], undefined);
  const mapped = analyze(p, { priceField: 'none', currency: 'unknown', skus: [{ sourceKey: 'opaque', dimensions: { color: 'red', size: 'large' } }] });
  assert.equal(mapped.skus[0].values['item.length'].value, 8.27);
});
test('conflicting same-scope text, ranges and non-mass net content do not produce guessed values', () => {
  const row = analyze(product([{ name: '净重', value: '120g' }, { name: '产品重量', value: '150g' }, { name: '高度', value: '10-20cm' }, { name: '净含量', value: '400ml' }])).skus[0];
  assert.equal(row.values['item.weight'], undefined);
  assert.equal(row.values['item.height'], undefined);
  assert.equal(row.values['content.weight'], undefined);
  assert.ok(row.evidence.some((e: any) => e.status === 'conflict'));
});
test('explicit labelled measurements in description are extracted without treating sale prices as weights', () => {
  const row = analyze(product([], '产品净重：85克；包装尺寸：12×8×3厘米；包装毛重：100克。售价120元，起订500件。')).skus[0];
  assert.equal(row.values['item.weight'].value, 0.19);
  assert.equal(row.values['package.weight'].value, 0.22);
  assert.equal(row.values['package.width'].value, 3.15);
  assert.equal(row.evidence.some((e: any) => /120元|500件/.test(e.sourceValue)), false);
});
test('detail HTML text remains available even when notesText is present, without HTML or scripts', () => {
  const raw = detailFixture(); raw.data.editCommonCollectBoxDetail.notesText = '材质：塑料';
  raw.data.editCommonCollectBoxDetail.notes = '<p>包装尺寸：12×8×3cm</p><script>secret()</script><p>毛重：100克</p>';
  const p = normalizeDetail(raw, '2026-10-07T08:00:00.000Z');
  assert.match((p as any).detailText ?? '', /毛重：100克/);
  assert.doesNotMatch((p as any).detailText ?? '', /<|secret/);
  assert.equal(analyze(p).skus[0].values['package.weight'].value, 0.22);
});
test('duration labels and unsupported tuple units cannot become centimetres', () => {
  const row = analyze(product([{ name: '使用时长', value: '20天' }, { name: '包装尺寸', value: '10×8×3 furlongs' }])).skus[0];
  assert.equal(row.values['item.length'], undefined);
  assert.equal(row.values['package.length'], undefined);
});
test('a clearly stated one-inch cube is not the one-centimetre placeholder', () => {
  const row = analyze(product([{ name: '包装尺寸', value: '1×1×1 inches' }])).skus[0];
  assert.equal(row.values['package.length']?.value, 1);
});
test('small/large prefixes on size options still bind their dimensions to the selected SKU', () => {
  const p = product();
  p.dimensions = [{ id: 'size', name: '尺寸', values: [{ id: 's', name: '小号12×8×3cm', imageUrls: [] }] }];
  assert.equal(analyze(p).skus[0].values['item.length']?.value, 4.72);
});
test('native inches and pounds retain their supplied precision; conversion alone uses ROUND(2)', () => {
  const row = analyze(product([{ name: '商品长度', value: '2.345 inches' }, { name: '包装毛重', value: '1.234 pounds' }])).skus[0];
  assert.equal(row.values['item.length']?.value, 2.345);
  assert.equal(row.values['package.weight']?.value, 1.234);
});
test('axis labels inside a package-size phrase remain package dimensions', () => {
  for (const value of ['长20cm 宽10cm 高5cm', '（长宽高）：20×10×5cm']) {
    const row = analyze(product([{ name: '包装尺寸', value }])).skus[0];
    assert.equal(row.values['package.length']?.value, 7.87);
    assert.equal(row.values['package.width']?.value, 3.94);
    assert.equal(row.values['package.height']?.value, 1.97);
    assert.equal(row.values['item.length'], undefined);
  }
});
