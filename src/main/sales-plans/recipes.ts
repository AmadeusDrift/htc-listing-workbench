import { createHash } from 'node:crypto';
import type { ProductDetail, Variant } from '../../shared/contracts.ts';
import type { MiaoshouReceipt } from '../../shared/miaoshou-contracts.ts';
import type { ListingRules } from '../../shared/listing-rules.ts';
import type { SalesComponent, SalesRecipe } from '../../shared/sales-plan-contracts.ts';
import { productSourceQuantity } from '../../shared/source-quantity.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { resolveMiaoshouSpecifications } from '../../shared/miaoshou-measurements.ts';
import { salesPurchaseComponents } from '../../shared/sales-purchase.ts';
import { exactSkuColorIdentity } from '../listing-ai/sku-colors.ts';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const money = (value: number) => Math.round((value + Number.EPSILON) * 1e8) / 1e8;
const colorValue = /透明蓝黄|透明青绿|鼠尾草绿|粉红色|灰绿|砖红|米白|雾蓝|(?:浅|深)?(?:蓝色|绿色|灰色|白色|黑色|红色|粉色|米色|棕色|橘色|橙色|黄色|紫色)|透明|\b(?:gray green|grey green|sage green|brick red|off white|dusty blue|blue|green|gr[ae]y|white|black|red|pink|beige|brown|orange|yellow|purple|clear)\b/giu;
function colorAndRemainder(name:string,value:string) {
  if(/材质|材料|型号|配件|附件|赠品|material|model|accessor/iu.test(name))return {color:'',remainder:value.trim()};
  // Supplier axes are frequently reversed. A whole, explicit shade is a
  // variation even under "尺寸"; keep its name instead of guessing a basic hue.
  const shade=value.trim().replace(/^定制款/u,'');
  const named=/^(?:夜光本色|春茶色?|松针绿色?|樱花粉色?|鼠尾草绿色?|玫瑰金色?|香槟色|原木色|透明蓝黄|透明青绿)(?:(?:渐变|单色|纯色|多色))*$/u;
  const joined=/^(?:炫彩)?(?:多色|混色)?(?:[红蓝绿黄橙橘紫粉白黑灰棕金银青]+(?:色)?)(?:[+＋、][红蓝绿黄橙橘紫粉白黑灰棕金银青]+(?:色)?)*(?:(?:渐变|多色|单色|纯色|色))*$/u;
  if(named.test(shade)||joined.test(shade))return {color:exactSkuColorIdentity(shade)??shade,remainder:''};
  const colors=value.match(colorValue)??[];
  if(colors.length) return {color:exactSkuColorIdentity(colors.join('/'))??colors.join('/'),remainder:value.replace(colorValue,'').replace(/[\s·,，、()（）-]+/gu,'').trim()};
  // Pattern names are only interchangeable when the value itself is a pattern, not a size/model hidden under a mislabeled axis.
  if(/图案|花色|pattern/iu.test(name)&&/^(?:条纹|格纹|波点|圆点|花朵|星星|纯色|stripes?|polka dots?|floral|solid)$/iu.test(value.trim()))return {color:value.trim(),remainder:''};
  return {color:'',remainder:value.trim()};
}
function identity(variant: Variant, receipt: MiaoshouReceipt | null) {
  const sourceKey = receipt?.skuMappings.find(row=>row.localVariantId===variant.id)?.sourceKey ?? variant.id;
  const dimensions = receipt ? resolveMiaoshouSpecifications(receipt.snapshot,sourceKey) : [];
  const spec=variant.normalizedSpec.trim()||variant.originalSpec;
  const axes=dimensions.length?dimensions.map(row=>({name:row.dimension.name,value:row.value.name})):spec.split(/[/;；\n]+/u).map(text=>{const colon=text.search(/[:：]/u);return {name:colon<0?'':text.slice(0,colon).trim(),value:colon<0?text.trim():text.slice(colon+1).trim()};});
  const parts=axes.map(axis=>({...axis,...colorAndRemainder(axis.name,axis.value)})),color=parts.filter(p=>p.color).map(p=>p.color).join('/');
  // An explicit pack count varies within a model; model identifiers, sizes and
  // accessory words remain part of its identity. Only strip unambiguous counts.
  const quantity=productQuantityIdentity(parts);
  return {sourceKey,color,groupKey:hash(color||quantity.varies?quantity.parts.filter(p=>p.remainder).map(p=>[p.name,p.remainder]).sort():[sourceKey,spec])};
}
function productQuantityIdentity(parts:{name:string;value:string;remainder:string}[]){
  let varies=false;
  const count=/(?<![\dA-Za-z.])\d+\s*(?:支|个|件|只|片|枚|条|根|张|粒|pcs?\b|pieces?\b)(?=装|盒|袋|包|套|[\s/，,;；)）\]】]|$)/giu;
  const normalized=parts.map(part=>{
    if(/配件|附件|附带|赠品|赠送|附赠|额外|accessor|included|free/iu.test(part.name+' '+part.value))return part;
    const matches=[...part.remainder.matchAll(count)];
    if(matches.length!==1||/起批|起订|起售|任选|随机|可备注/u.test(part.value))return part;
    varies=true;return {...part,remainder:part.remainder.replace(count,'[件数]')};
  });
  return {parts:normalized,varies};
}
export function sourceQuotedCost(variant: Variant, receipt: MiaoshouReceipt | null): number | null {
  if (variant.purchasePrice.trim()) return Number(variant.purchasePrice)>0 && Number.isFinite(Number(variant.purchasePrice)) ? Number(variant.purchasePrice) : null;
  if (!receipt?.snapshot.sources.some(source=>source.source==='1688')) return null;
  const key=receipt.skuMappings.find(row=>row.localVariantId===variant.id)?.sourceKey;
  const source=receipt.snapshot.skus.find(sku=>sku.key===key), value=source?.[receipt.mapping.priceField==='oriPrice'?'oriPrice':'price'];
  return value && Number(value)>0 && Number.isFinite(Number(value)) ? Number(value) : null;
}
function recipe(groupKey: string, components: SalesComponent[], color: string, specification: string): SalesRecipe {
  const sorted=[...components].sort((a,b)=>a.sourceKey.localeCompare(b.sourceKey));
  const totalPieces=sorted.reduce((sum,c)=>sum+c.quantity,0);
  return {key:hash(sorted.map(c=>[c.sourceKey,c.quantity])),groupKey,color,specification,components:sorted,totalPieces,
    totalCostCny:sorted.every(c=>c.quotedCostCny!==null)?money(sorted.reduce((sum,c)=>sum+c.quotedCostCny!*c.quantity/c.piecesPerQuote,0)):null};
}
/** Linear number of sales SKUs: each selected source color plus at most one mixed recipe per same-spec group. */
export function buildSalesRecipes(product: ProductDetail, receipt: MiaoshouReceipt | null, rules: ListingRules): SalesRecipe[] {
  const entries=product.variants.slice(0,rules.product.variantLimit).map(variant=>{
    const {sourceKey,color,groupKey}=identity(variant,receipt), spec=variant.normalizedSpec.trim()||variant.originalSpec;
    const units=productSourceQuantity(product,variant,receipt?.snapshot.detailText), quotedCostCny=sourceQuotedCost(variant,receipt);
    if (units.conflict) throw new UserFacingError(`规格「${spec}」中的件数或计价口径冲突`);
    const unitCost=quotedCostCny===null?null:quotedCostCny/units.piecesPerQuote;
    const eligible=rules.pricing.bundleEnabled && unitCost!==null && unitCost/rules.pricing.fx<rules.pricing.bundleThresholdUsd;
    const quantity=units.source==='explicit' ? units.piecesPerPack : eligible ? rules.pricing.bundleSizes.find(size=>unitCost!*size/rules.pricing.fx<=rules.pricing.bundleCapUsd+1e-10) ?? 1 : 1;
    const component: SalesComponent={variantId:variant.id,sourceKey,sourceSku:variant.sku,specification:spec,color,quantity,quotedCostCny,piecesPerQuote:units.piecesPerQuote,sourcePackPieces:units.piecesPerPack};
    return {groupKey,component,eligible};
  });
  const result=entries.map(entry=>recipe(entry.groupKey,[entry.component],entry.component.color,`${entry.component.specification} · ${entry.component.quantity} pc`));
  const groups=new Map<string,typeof entries>();
  for (const entry of entries) {const group=groups.get(entry.groupKey)??[];group.push(entry);groups.set(entry.groupKey,group);}
  for (const [groupKey, group] of groups) {
    const colors=group.filter(entry=>entry.eligible && entry.component.color).sort((a,b)=>a.component.sourceKey.localeCompare(b.component.sourceKey));
    if (colors.length<2 || new Set(colors.map(entry=>entry.component.color)).size!==colors.length) continue;
    for (const total of rules.pricing.bundleSizes) {
      const selected=colors.slice(0,Math.min(colors.length,total));
      if (selected.length<2) continue;
      const components=selected.map((entry,index)=>({...entry.component,quantity:Math.floor(total/selected.length)+(index<total%selected.length?1:0)}));
      const candidate=recipe(groupKey,components,'Mixed colors',`混色 ${total} pc（${components.map(c=>`${c.color}×${c.quantity}`).join('、')}）`);
      if (candidate.totalCostCny!==null && candidate.totalCostCny/rules.pricing.fx<=rules.pricing.bundleCapUsd+1e-10) {result.push(candidate);break;}
    }
  }
  return result;
}
export function procurementComponents(lines: {recipe:SalesRecipe;sets:number}[]) {
  const totals=new Map<string,ReturnType<typeof salesPurchaseComponents>[number]>();
  for (const {recipe,sets} of lines) for (const c of salesPurchaseComponents(recipe,sets)) {
    const key=JSON.stringify([c.variantId,c.sourceKey]), current=totals.get(key);
    if(!current){totals.set(key,c);continue;}
    current.pieces+=c.pieces;current.quoteUnits+=c.quoteUnits;
    current.costCny=current.costCny===null||c.costCny===null?null:money(current.costCny+c.costCny);
    current.needsSplit ||= c.needsSplit;
  }
  return [...totals.values()];
}
