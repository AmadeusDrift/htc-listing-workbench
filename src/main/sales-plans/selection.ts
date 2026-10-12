import type { MiaoshouReceipt } from '../../shared/miaoshou-contracts.ts';
import { analyzeMiaoshouMeasurements } from '../../shared/miaoshou-measurements.ts';
import type { ProductDetail, Variant } from '../../shared/contracts.ts';
import type { SalesRecipe } from '../../shared/sales-plan-contracts.ts';
import { quoteListing, type ListingRules } from '../../shared/listing-rules.ts';

/** Match a whole supplier option/axis, never the presence of a remark in a real configuration. */
export function informationalVariant(variant: Variant): boolean {
  return [variant.sourceSpec,variant.originalSpec,variant.normalizedSpec].some(spec=>spec.split(/[/;；\n]+/u).some(axis=>{
    const value=axis.replace(/^[^:：]*[:：]/u,'').trim().replace(/[~～!！。\s]+$/u,'');
    return /^(?:春夏秋冬\s*[-—·]?\s*)?可备注颜色$/u.test(value)
      || /^(?:更低价格|低价|优惠价格)?请咨询客服$/u.test(value);
  }));
}

/** Ranking only: absent/uncertain facts do not become exclusion rules. */
export function selectSalesRecipes(product: ProductDetail, recipes: SalesRecipe[], rules: ListingRules, receipt: MiaoshouReceipt | null = null): SalesRecipe[] {
  const measurements=receipt?analyzeMiaoshouMeasurements(receipt.snapshot,receipt.mapping):null;
  const candidates=recipes.filter(recipe=>recipe.components.every(c=>{
    const variant=product.variants.find(v=>v.id===c.variantId);return !variant||!informationalVariant(variant);
  })).map(recipe=>{
    const specs=recipe.components.map(c=>c.specification);
    const accessory=specs.some(spec=>/^(?:(?:型号|规格|颜色)[:：]\s*)?(?:仅配件|仅附件|替换芯|配件单卖)(?:\s*[/;；]|$)/u.test(spec));
    const traceable=recipe.components.every(c=>product.assets.some(asset=>asset.variantIds.includes(c.variantId))||!!receipt?.skuMappings.find(m=>m.localVariantId===c.variantId)?.imageIds.some(id=>receipt.snapshot.images.some(image=>image.id===id)));
    // Use resolved supplier package measurements, with business defaults for missing axes.
    // Unresolved local measurement facts stay unknown here; full pricing runs downstream.
    let qualified=false;
    if(recipe.totalCostCny!==null&&rules.product.dimensionFallback&&rules.product.weightFallback
      &&!product.facts.some(f=>/尺寸|重量|长|宽|高|weight|dimension|length|width|height/iu.test(f.name))){
      const p=rules.product;
      const component=recipe.components.length===1?recipe.components[0]:null;
      const source=component&&component.quantity===component.sourcePackPieces?measurements?.skus.find(s=>s.sourceKey===component.sourceKey):null;
      const value=(field:'package.length'|'package.width'|'package.height'|'package.weight',fallback:number)=>{const e=source?.values[field];return !e?fallback:['usable','inferred'].includes(e.status)?e.value??NaN:NaN;};
      const dimensions=p.dimensions.map((v,i)=>value((['package.length','package.width','package.height'] as const)[i],p.dimensionUnit==='cm'?v/2.54:v)) as [number,number,number];
      const weight=value('package.weight',p.weightUnit==='g'?p.packageWeight/453.59237:p.packageWeight);
      try{quoteListing({costCny:recipe.totalCostCny,dimensionsInches:dimensions,weightPounds:weight},rules.pricing);qualified=true;}catch{/* Unknown or failing quotes remain candidates, never silent pricing rejection. */}
    }
    return {recipe,rank:[Number(!accessory),Number(recipe.components.length===1),Number(specs.every(s=>!!s.trim())),Number(traceable),Number(qualified)]};
  });
  const selected:SalesRecipe[]=[],colors=new Set<string>(),groups=new Set<string>();
  while(candidates.length&&selected.length<Math.min(4,rules.product.variantLimit)){
    candidates.sort((a,b)=>{
      for(let i=0;i<a.rank.length;i++)if(a.rank[i]!==b.rank[i])return b.rank[i]-a.rank[i];
      const diversity=(r:SalesRecipe)=>Number(!!r.color&&!colors.has(r.color))+Number(!groups.has(r.groupKey));
      return diversity(b.recipe)-diversity(a.recipe)||a.recipe.key.localeCompare(b.recipe.key);
    });
    const {recipe}=candidates.shift()!;selected.push(recipe);colors.add(recipe.color);groups.add(recipe.groupKey);
  }
  const keys=new Set(selected.map(r=>r.key));
  return recipes.filter(r=>keys.has(r.key));
}
