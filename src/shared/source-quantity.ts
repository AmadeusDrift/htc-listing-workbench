import { factsForVariant } from './fact-scopes.ts';
import type { ProductDetail, Variant } from './contracts.ts';
/** Supplier quote quantity is separate from the pieces in one sale package. */
export interface SourceQuantity {
  piecesPerPack: number;
  piecesPerQuote: number;
  quoteBasis: 'piece' | 'pack';
  source: 'explicit' | 'default';
  evidence: string;
  conflict: boolean;
}
const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function integer(text: string): number {
  if (/^\d+$/.test(text)) return Number(text);
  let sum = 0, number = 0;
  for (const char of text) {
    if (char in digits) number = digits[char];
    else { sum += (number || 1) * ({ 十: 10, 百: 100, 千: 1000 }[char] || 0); number = 0; }
  }
  return sum + number;
}
function counts(text: string): { value: number; evidence: string }[] {
  const result: { value: number; evidence: string }[] = [];
  const patterns = [
    /([0-9零一二两三四五六七八九十百千]+)\s*(?:个|件|支|只|片|枚|条|根|张|粒)(?:\s*(?:[/／]\s*)?(?:盒装|袋装|包装|装|套|包|盒|袋))?/gu,
    /\b(\d+)\s*(?:pcs?|pieces?)\b/giu,
    /\b(?:pack|set|box)\s*(?:of\s*)?(\d+)\b/giu,
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    if(/^\s*(?:起批|起订|起售)/u.test(text.slice((match.index??0)+match[0].length)))continue;
    const value = integer(match[1]);
    if (Number.isSafeInteger(value) && value > 0 && value <= 100000) result.push({ value, evidence: match[0] });
  }
  return result;
}
export function sourceQuantity(selectedSpec: string, productText = '', quoteText = ''): SourceQuantity {
  const selected = counts(selectedSpec), fallback = selected.length ? [] : counts(productText);
  const found = selected.length ? selected : fallback;
  const context = `${selected.length ? selectedSpec : `${selectedSpec}\n${productText}`}\n${quoteText}`;
  const each = /单[个件支只片枚条根张粒](?:价|价格|报价)|每[个件支只片枚条根张粒](?:价|价格|报价)|按[个件支只片枚条根张粒](?:计价|报价)|\b(?:price|priced|cost)\s*(?:is\s*)?(?:per|for\s+one)\s*(?:piece|pc|item|unit)\b/iu.test(context);
  const pack = /整[包盒袋套](?:价|价格|报价)|每[包盒袋套](?:价|价格|报价)|\b(?:price|priced|cost)\s*per\s*(?:pack|box|set)\b/iu.test(context);
  if (!found.length) return { piecesPerPack: 1, piecesPerQuote: 1, quoteBasis: 'piece', source: 'default', evidence: '', conflict: each && pack };
  const count = found[0].value;
  return { piecesPerPack: count, piecesPerQuote: each ? 1 : count, quoteBasis: each || count === 1 ? 'piece' : 'pack', source: 'explicit',
    evidence: context.slice(0, 2000), conflict: new Set(found.map(entry => entry.value)).size > 1 || each && pack };
}
export function sourcePackCost(quotedCny: number, quantity: SourceQuantity): number {
  if (quantity.conflict || !Number.isFinite(quotedCny) || quotedCny <= 0) throw new Error('来源采购数量或价格无效');
  return Math.round((quotedCny * quantity.piecesPerPack / quantity.piecesPerQuote + Number.EPSILON) * 1e8) / 1e8;
}
/** Selected SKU wording wins; unambiguous product packaging text is a fallback before 1 pc. */
export function productSourceQuantity(product: ProductDetail, variant: Variant, detailText = ''): SourceQuantity {
  const scoped=product.facts.some(f=>f.scope!==undefined);
  product={...product,facts:factsForVariant(product,variant.id),...(scoped?{title:'',description:''}:{})};
  if(scoped)detailText='';
  const spec=variant.normalizedSpec.trim()||variant.originalSpec;
  const quoteText=[variant.originalSpec,product.description,detailText,...product.facts.filter(f=>['source_confirmed','human_confirmed'].includes(f.state)&&/计价|报价|quote.?basis/iu.test(f.name)).map(f=>`${f.name}:${f.value}`)].join('\n');
  const primary=sourceQuantity(spec,product.title,quoteText);
  if(primary.source==='explicit'||primary.conflict)return primary;
  const facts=product.facts.filter(f=>['source_confirmed','human_confirmed'].includes(f.state)&&/^(?:售卖件数|销售件数|商品数量|数量|件数|包装数量|包装规格|quantity|number.?of.?items|unit.?count)$/iu.test(f.name.trim()))
    .map(f=>/^\d+$/u.test(f.value.trim())?`${f.value} pc`:f.value);
  const fallback=sourceQuantity(spec,[...facts,product.description,detailText].join('\n'),quoteText);
  // Multiple counts in a shared description may describe different variants. They are not selected-SKU evidence.
  return fallback.conflict&&product.variants.length>1?primary:fallback;
}
