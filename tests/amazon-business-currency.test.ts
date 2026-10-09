import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmedPurchaseCurrency } from '../src/main/amazon/business-currency.ts';
const human = (name:string,value:string) => ({name,value,state:'human_confirmed' as const});
test('contradictory or explicitly non-CNY current facts suppress CNY receipt pricing',()=>{
  const conflict=confirmedPurchaseCurrency([human('采购币种','CNY'),human('purchase_currency','USD')],true);
  assert.equal(conflict.cny,false);assert.match(conflict.notice!,/冲突/);
  assert.equal(confirmedPurchaseCurrency([human('采购币种','USD')],true).cny,false);
  assert.equal(confirmedPurchaseCurrency([{...human('采购币种','CNY'),state:'conflicting'}],true).cny,false);
});
test('confirmed human choice takes precedence and receipt only fills absence of currency facts',()=>{
  assert.equal(confirmedPurchaseCurrency([],true).cny,true);
  assert.equal(confirmedPurchaseCurrency([],false).cny,false);
  assert.equal(confirmedPurchaseCurrency([human('采购币种',' cny ')],false).cny,true);
  assert.equal(confirmedPurchaseCurrency([human('采购币种','CNY'),{...human('purchase_currency','USD'),state:'source_confirmed'}],false).cny,true);
  assert.equal(confirmedPurchaseCurrency([{...human('purchase_currency','USD'),state:'source_confirmed'}],true).cny,false);
});
