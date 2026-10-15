import { factsForVariant, hasFactScopeModel } from './fact-scopes.ts';
import type { ProductDetail, Variant } from './contracts.ts';
/** Supplier quote quantity is separate from the pieces in one sale package. */
export interface SourceQuantity {
  piecesPerPack: number;
  piecesPerQuote: number;
  quoteBasis: 'piece' | 'pack';
  source: 'explicit' | 'default';
  evidence: string;
  conflict: boolean;
  unitSemantics?: SourceUnitSemantics;
}
export interface SourceContent { name:string; quantity:number|null; role:'main'|'accessory' }
export interface SourceUnitSemantics {
  version:2; kind:'kit'|'unknown'; quoteUnit:'kit'|'unknown'; saleUnit:'kit'|'unknown';
  mainQuantity:number|null; contents:SourceContent[];
}
interface UnitRecipe {totalPieces:number;quantityVersion?:2;platformPieces?:number|null;components:{specification:string;unitSemantics?:SourceUnitSemantics}[]}
export function salesPlatformPieces(recipe:Pick<UnitRecipe,'totalPieces'|'quantityVersion'|'platformPieces'>):number|null {
  return recipe.quantityVersion===2?recipe.platformPieces??null:recipe.totalPieces;
}
/** Legacy records remain readable; internal numerical consistency is not proof of a valid sale unit. */
export function salesUnitIssue(recipe:UnitRecipe):string|null {
  if(recipe.quantityVersion!==2&&recipe.components.some(c=>sourceQuantity(c.specification).unitSemantics))return '历史配方把套装或未确认单位用于件数/成本计算；请查看计量对照并明确采用，原记录保持不变';
  if(recipe.components.some(c=>c.unitSemantics?.quoteUnit==='unknown'))return '来源报价单位未确认；未计算销售成本或平台件数';
  if(recipe.quantityVersion===2&&salesPlatformPieces(recipe)===null)return '整套报价与附件数量已分开，平台销售件数仍待明确确认；不能将附件数直接作为销售件数';
  return null;
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
/** Structural composition is not a count of interchangeable sale items. Pure refill packs stay homogeneous. */
function kitContents(text:string):SourceContent[]|null {
  const parts=text.split(/\s*(?:[+＋]|附带|附赠|配有|包含|含有|[（(]含)\s*/u);
  if(parts.length<2||!parts.slice(1).some(p=>counts(p).length&&/[个件支只片枚条根张粒]\s*[^\s/，,;；)）+＋0-9]/u.test(p)))return null;
  const main=parts[0].split(/[/／;；\n]/u).at(-1)!.replace(/^\s*(?:规格|配置|套装|型号)\s*[:：]/u,'').trim();
  if(!main||/^(?:颜色\s*[:：]\s*)?(?:[红蓝绿黄白黑米粉紫橙]+色?|red|blue|yellow|beige)$/iu.test(main))return null;
  return [main,...parts.slice(1)].map((part,index)=>{
    const found=counts(part),evidence=found[0]?.evidence??'';
    const name=part.replace(evidence,'').replace(/[()（）]/gu,'').replace(/[，,;；\n].*$/u,'').trim();
    return {name:name||part.trim(),quantity:found.length===1?found[0].value:null,role:index===0?'main' as const:'accessory' as const};
  });
}
export function sourceQuantity(selectedSpec: string, productText = '', quoteText = '', compositionText=quoteText): SourceQuantity {
  const selected = counts(selectedSpec), fallback = selected.length ? [] : counts(productText);
  const found = selected.length ? selected : fallback;
  const context = `${selected.length ? selectedSpec : `${selectedSpec}\n${productText}`}\n${quoteText}`;
  const each = /单[个件支只片枚条根张粒](?:价|价格|报价)|每[个件支只片枚条根张粒](?:价|价格|报价)|按[个件支只片枚条根张粒](?:计价|报价)|\b(?:price|priced|cost)\s*(?:is\s*)?(?:per|for\s+one)\s*(?:piece|pc|item|unit)\b/iu.test(context);
  const contents=kitContents(selectedSpec)??kitContents(compositionText)??(!selected.length?kitContents(productText):null);
  if(!contents&&/(?:报价|计价)(?:单位|口径)?(?:不明|未知|未确认)|quote\s*(?:unit|basis)\s*(?:unknown|unconfirmed)/iu.test(context))
    return {piecesPerPack:1,piecesPerQuote:1,quoteBasis:'pack',source:'explicit',evidence:context.slice(0,2000),conflict:false,
      unitSemantics:{version:2,kind:'unknown',quoteUnit:'unknown',saleUnit:'unknown',mainQuantity:null,contents:[]}};
  if(contents)return {piecesPerPack:1,piecesPerQuote:1,quoteBasis:'pack',source:'explicit',evidence:context.slice(0,2000),conflict:false,
    unitSemantics:{version:2,kind:'kit',quoteUnit:each||/(?:报价|计价)(?:单位|口径)?(?:不明|未知|未确认)/u.test(context)?'unknown':'kit',saleUnit:'kit',mainQuantity:contents[0].quantity,contents}};
  const pack = /整[包盒袋套](?:价|价格|报价)|每[包盒袋套](?:价|价格|报价)|\b(?:price|priced|cost)\s*per\s*(?:pack|box|set)\b/iu.test(context);
  if (!found.length) return { piecesPerPack: 1, piecesPerQuote: 1, quoteBasis: 'piece', source: 'default', evidence: '', conflict: each && pack };
  const count = found[0].value;
  return { piecesPerPack: count, piecesPerQuote: each ? 1 : count, quoteBasis: each || count === 1 ? 'piece' : 'pack', source: 'explicit',
    evidence: context.slice(0, 2000), conflict: new Set(found.map(entry => entry.value)).size > 1 || each && pack };
}
export function sourcePackCost(quotedCny: number, quantity: SourceQuantity): number {
  if(quantity.unitSemantics?.quoteUnit==='unknown')throw new Error('来源报价单位未确认');
  if (quantity.conflict || !Number.isFinite(quotedCny) || quotedCny <= 0) throw new Error('来源采购数量或价格无效');
  return Math.round((quotedCny * quantity.piecesPerPack / quantity.piecesPerQuote + Number.EPSILON) * 1e8) / 1e8;
}
/** Selected SKU wording wins; unambiguous product packaging text is a fallback before 1 pc. */
export function productSourceQuantity(product: ProductDetail, variant: Variant, detailText = ''): SourceQuantity {
  const scoped=hasFactScopeModel(product);
  product={...product,facts:factsForVariant(product,variant.id),...(scoped?{title:'',description:''}:{})};
  if(scoped)detailText='';
  const spec=variant.normalizedSpec.trim()||variant.originalSpec;
  const quoteText=[variant.originalSpec,product.description,detailText,...product.facts.filter(f=>['source_confirmed','human_confirmed'].includes(f.state)&&/计价|报价|quote.?basis/iu.test(f.name)).map(f=>`${f.name}:${f.value}`)].join('\n');
  const primary=sourceQuantity(spec,product.title,quoteText,variant.originalSpec);
  if(primary.source==='explicit'||primary.conflict)return primary;
  const facts=product.facts.filter(f=>['source_confirmed','human_confirmed'].includes(f.state)&&/^(?:售卖件数|销售件数|商品数量|数量|件数|包装数量|包装规格|quantity|number.?of.?items|unit.?count)$/iu.test(f.name.trim()))
    .map(f=>/^\d+$/u.test(f.value.trim())?`${f.value} pc`:f.value);
  const fallback=sourceQuantity(spec,[...facts,product.description,detailText].join('\n'),quoteText,variant.originalSpec);
  // Multiple counts in a shared description may describe different variants. They are not selected-SKU evidence.
  return fallback.conflict&&product.variants.length>1?primary:fallback;
}
