import type { Fact } from '../../shared/contracts.ts';

/** Explicit current currency facts precede a previously selected import mapping. */
export function confirmedPurchaseCurrency(facts: Pick<Fact,'name'|'value'|'state'>[], receiptCny: boolean): { cny: boolean; notice: string | null } {
  const currencies = facts.filter(fact => ['采购币种','purchasecurrency'].includes(fact.name.toLowerCase().replace(/[\s_-]/g,'')));
  if (currencies.some(fact => fact.state === 'conflicting')) return { cny: false, notice: '采购币种存在冲突，未根据旧导入映射计算报价' };
  const human = currencies.filter(fact => fact.state === 'human_confirmed');
  const selected = human.length ? human : currencies.filter(fact => fact.state === 'source_confirmed');
  if (!selected.length) return { cny: receiptCny, notice: null };
  const values = new Set(selected.map(fact => fact.value.trim().toUpperCase()));
  if (values.size !== 1) return { cny: false, notice: '已确认的采购币种相互冲突，请核对后再计算报价' };
  return values.has('CNY') ? { cny: true, notice: null } : { cny: false, notice: '当前采购币种不是已确认的人民币，未套用人民币定价公式' };
}
