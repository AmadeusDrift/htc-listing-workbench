import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceQuantity, sourcePackCost } from '../src/shared/source-quantity.ts';

test('unspecified source quantity always falls back to one piece', () => {
  for (const value of ['', '红色', '长5厘米 宽5厘米 100g', '颜色:绿色 / 尺寸:均码']) {
    assert.deepEqual(sourceQuantity(value), { piecesPerPack: 1, piecesPerQuote: 1, quoteBasis: 'piece', source: 'default', evidence: '', conflict: false });
  }
});
test('selected pack prices and explicit per-piece prices have different cost bases', () => {
  assert.equal(sourceQuantity('红色 10 件装').piecesPerQuote, 10);
  const each = sourceQuantity('【10个装】单个价格');
  assert.equal(each.piecesPerPack, 10); assert.equal(each.piecesPerQuote, 1);
  assert.equal(sourcePackCost(.38, each), 3.8);
  const box = sourceQuantity('50支/盒，整盒价格');
  assert.equal(box.piecesPerQuote, 50); assert.equal(sourcePackCost(1.5, box), 1.5);
  assert.equal(sourceQuantity('pack of 12').piecesPerPack, 12);
  assert.equal(sourceQuantity('两件装').piecesPerPack, 2);
  assert.equal(sourceQuantity('10pcs per pack, price per piece').piecesPerQuote, 1);
});
test('selected SKU quantity overrides generic product title while absent SKU count reads the title', () => {
  assert.equal(sourceQuantity('红色 2件装', '家庭 50件装').piecesPerPack, 2);
  assert.equal(sourceQuantity('红色', '家庭装牙线棒50支盒装').piecesPerPack, 50);
  assert.equal(sourceQuantity('红色', '普通家庭装').piecesPerPack, 1);
  assert.equal(sourceQuantity('10件装，20件装').conflict, true);
});
test('quote basis survives a normalized spec and a wholesale minimum is not pack content',()=>{
  const pack=sourceQuantity('红色 10 pc','普通夹子','【10个装】单个价格');
  assert.equal(pack.piecesPerQuote,1);assert.equal(sourcePackCost(.38,pack),3.8);
  assert.equal(sourceQuantity('红色','普通夹子 20件起批').piecesPerPack,1);
});
