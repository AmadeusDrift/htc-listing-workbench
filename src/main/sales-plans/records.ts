import { factsForVariant } from '../../shared/fact-scopes.ts';
import { createHash } from 'node:crypto';
import type { SalesListingPlan, SalesRecipe } from '../../shared/sales-plan-contracts.ts';
import type { ProductDetail } from '../../shared/contracts.ts';
import { identifier, record, text } from '../../shared/validation.ts';
import { assertSafeSku } from '../../shared/sku-naming.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { skuDependentSourceFact } from '../amazon/demo.ts';
import type { SourceUnitSemantics } from '../../shared/source-quantity.ts';
import { salesPlatformPieces } from '../../shared/source-quantity.ts';

const fail = (): never => { throw new UserFacingError('销售组合记录无效'); };
const hash = (v:unknown):string => typeof v==='string' && /^[a-f0-9]{64}$/.test(v) ? v : fail();
const integer = (v:unknown,max=1000000):number => Number.isSafeInteger(v) && Number(v)>0 && Number(v)<=max ? Number(v) : fail();
const cost = (v:unknown):number|null => v===null ? null : typeof v==='number' && Number.isFinite(v) && v>0 && v<=1e9 ? v : fail();
const exact = (v:unknown,names:string[],optional:string[]=[]) => {const o=record(v,'销售组合',[...names,...optional]); if(names.some(n=>!Object.hasOwn(o,n))) fail();return o;};
export function validateUnitSemantics(raw:unknown):SourceUnitSemantics {
  const v=exact(raw,['version','kind','quoteUnit','saleUnit','mainQuantity','contents']);
  if(v.version!==2||!['kit','unknown'].includes(String(v.kind))||!['kit','unknown'].includes(String(v.quoteUnit))||v.kind==='unknown'&&v.quoteUnit!=='unknown'||v.saleUnit!==v.kind||!Array.isArray(v.contents)||v.contents.length>100)fail();
  const contents=(v.contents as unknown[]).map(raw=>{const c=exact(raw,['name','quantity','role']);if(!['main','accessory'].includes(String(c.role)))fail();return {name:text(c.name,'组成',2000,true),quantity:c.quantity===null?null:integer(c.quantity),role:c.role as 'main'|'accessory'};});
  const mainQuantity=v.mainQuantity===null?null:integer(v.mainQuantity);
  if(v.kind==='unknown'&&(contents.length||mainQuantity!==null)||v.kind==='kit'&&(!contents.length||contents[0].role!=='main'||contents[0].quantity!==mainQuantity||contents.slice(1).some(c=>c.role!=='accessory')))fail();
  return {version:2,kind:v.kind as SourceUnitSemantics['kind'],quoteUnit:v.quoteUnit as SourceUnitSemantics['quoteUnit'],saleUnit:v.saleUnit as SourceUnitSemantics['saleUnit'],mainQuantity,contents};
}
export function validateSalesRecipe(raw:unknown):SalesRecipe {
  const value=exact(raw,['key','groupKey','specification','color','components','totalPieces','totalCostCny'],['quantityVersion','platformPieces']);
  const versioned=Object.hasOwn(value,'quantityVersion');
  if(versioned?(value.quantityVersion!==2||!Object.hasOwn(value,'platformPieces')):Object.hasOwn(value,'platformPieces'))fail();
  if(!Array.isArray(value.components)||!value.components.length||value.components.length>200) fail();
  const components=(value.components as unknown[]).map(raw=>{
    const c=exact(raw,['variantId','sourceKey','sourceSku','specification','color','quantity','quotedCostCny','piecesPerQuote','sourcePackPieces'],['unitSemantics']);
    const units=Object.hasOwn(c,'unitSemantics')?validateUnitSemantics(c.unitSemantics):undefined;
    if(units&&(!versioned||c.piecesPerQuote!==1||c.sourcePackPieces!==1))fail();
    return {variantId:identifier(c.variantId),sourceKey:text(c.sourceKey,'来源规格',500,true),sourceSku:text(c.sourceSku,'来源 SKU',200,true),specification:text(c.specification,'规格',4000),color:text(c.color,'颜色',500),
      quantity:integer(c.quantity),quotedCostCny:cost(c.quotedCostCny),piecesPerQuote:integer(c.piecesPerQuote),sourcePackPieces:integer(c.sourcePackPieces),...(units?{unitSemantics:units}:{})};
  });
  if(new Set(components.map(c=>c.sourceKey)).size!==components.length||new Set(components.map(c=>c.variantId)).size!==components.length) fail();
  const totalPieces=integer(value.totalPieces,1e8),totalCostCny=cost(value.totalCostCny);
  const expectedCost=components.every(c=>c.quotedCostCny!==null&&c.unitSemantics?.quoteUnit!=='unknown')?Math.round(components.reduce((n,c)=>n+c.quotedCostCny!*c.quantity/c.piecesPerQuote,0)*1e8)/1e8:null;
  const key=createHash('sha256').update(JSON.stringify([...components].sort((a,b)=>a.sourceKey.localeCompare(b.sourceKey)).map(c=>[c.sourceKey,c.quantity]))).digest('hex');
  if(totalPieces!==components.reduce((n,c)=>n+c.quantity,0)||key!==value.key||expectedCost!==totalCostCny) fail();
  const platformPieces=versioned?(value.platformPieces===null?null:integer(value.platformPieces,1e8)):undefined;
  if(versioned&&(!components.some(c=>c.unitSemantics)&&platformPieces!==totalPieces||components.some(c=>c.unitSemantics?.kind==='unknown')&&platformPieces!==null))fail();
  return {key:hash(value.key),groupKey:hash(value.groupKey),specification:text(value.specification,'销售规格',10000,true),color:text(value.color,'颜色',500),components,totalPieces,totalCostCny,...(versioned?{quantityVersion:2,platformPieces:platformPieces!}:{})};
}
export function validateSalesPlan(raw:unknown):SalesListingPlan {
  const v=exact(raw,['namingGroupId','sourceGroupKey','collectedAt','collectionBasis','sku','baseSku','recipe','parentage','parentSku','variationTheme','relationReason','familyResolved','namingChildKey'],['familyBinding','unitAdoption']);
  if(!['source','first_import'].includes(String(v.collectionBasis))||!['NONE','PARENT','CHILD'].includes(String(v.parentage))||typeof v.familyResolved!=='boolean'
    ||typeof v.collectedAt!=='string'||!Number.isFinite(Date.parse(v.collectedAt))) fail();
  const result:SalesListingPlan={namingGroupId:identifier(v.namingGroupId),sourceGroupKey:text(v.sourceGroupKey,'来源组',1024,true),collectedAt:v.collectedAt as string,
    collectionBasis:v.collectionBasis as SalesListingPlan['collectionBasis'],sku:assertSafeSku(v.sku),baseSku:assertSafeSku(v.baseSku),recipe:validateSalesRecipe(v.recipe),
    parentage:v.parentage as SalesListingPlan['parentage'],parentSku:v.parentSku===null?null:assertSafeSku(v.parentSku),variationTheme:v.variationTheme===null?null:text(v.variationTheme,'变体主题',200,true),
    relationReason:text(v.relationReason,'关系依据',2000),familyResolved:v.familyResolved as boolean,namingChildKey:v.namingChildKey===null?null:hash(v.namingChildKey)};
  if(Object.hasOwn(v,'familyBinding')) {
    const binding=exact(v.familyBinding,['parentNamingGroupId','parentSourceGroupKey','parentBaseSku']);
    result.familyBinding={parentNamingGroupId:identifier(binding.parentNamingGroupId),
      parentSourceGroupKey:text(binding.parentSourceGroupKey,'父体来源组',1024,true),parentBaseSku:assertSafeSku(binding.parentBaseSku)};
    if(result.parentage!=='CHILD'||!result.familyResolved) fail();
  }
  const parentBaseSku=result.familyBinding?.parentBaseSku??result.baseSku;
  if(Object.hasOwn(v,'unitAdoption')){
    const a=exact(v.unitAdoption,['version','originalRecipeKey','previousRecipe','at','basis']),previousRecipe=validateSalesRecipe(a.previousRecipe);
    if(a.version!==1||typeof a.at!=='string'||!Number.isFinite(Date.parse(a.at))||result.recipe.quantityVersion!==2||result.recipe.platformPieces===null||previousRecipe.key!==a.originalRecipeKey)fail();
    result.unitAdoption={version:1,originalRecipeKey:hash(a.originalRecipeKey),previousRecipe,at:a.at as string,basis:text(a.basis,'计量确认依据',2000,true)};
    if(result.namingChildKey!==null&&result.namingChildKey!==result.unitAdoption.originalRecipeKey)fail();
    if(previousRecipe.components.length!==1||result.recipe.components.length!==1||previousRecipe.components[0].variantId!==result.recipe.components[0].variantId||previousRecipe.components[0].sourceKey!==result.recipe.components[0].sourceKey||previousRecipe.components[0].sourceSku!==result.recipe.components[0].sourceSku)fail();
    if(previousRecipe.components[0].quantity!==previousRecipe.components[0].sourcePackPieces||result.recipe.components[0].quantity!==1||result.recipe.components[0].sourcePackPieces!==1||result.recipe.components[0].unitSemantics?.quoteUnit!=='kit'||result.recipe.groupKey!==previousRecipe.groupKey)fail();
  }
  if(result.parentage==='CHILD' && (result.parentSku!==parentBaseSku||!result.variationTheme||result.sku===parentBaseSku)
    ||result.parentage==='PARENT' && (result.sku!==result.baseSku||result.parentSku!==null||!result.variationTheme)
    ||result.parentage==='NONE' && (result.parentSku!==null||result.variationTheme!==null)
    ||result.namingChildKey!==null && result.namingChildKey!==(result.unitAdoption?.originalRecipeKey??result.recipe.key)) fail();
  return result;
}
/** A listing view of source data, never a mutation of the collected product or supplier SKU. */
export function projectSalesProduct(product:ProductDetail, plan:SalesListingPlan|undefined, anchorVariantId:string):ProductDetail {
  if(!plan) return {...product,facts:factsForVariant(product,anchorVariantId)};
  const sale=validateSalesPlan(plan);
  if(!sale.recipe.components.some(c=>c.variantId===anchorVariantId)) throw new UserFacingError('销售组合与来源规格不一致');
  for(const component of sale.recipe.components){
    const variant=product.variants.find(v=>v.id===component.variantId);
    if(!variant||variant.sku!==component.sourceSku) throw new UserFacingError('销售组合的来源 SKU 已变化');
  }
  const projected=structuredClone(product), parent=sale.parentage==='PARENT';
  const variant=projected.variants.find(v=>v.id===anchorVariantId)!;
  variant.sku=sale.sku;variant.purchasePrice=sale.recipe.totalCostCny===null?'':String(sale.recipe.totalCostCny);
  variant.normalizedSpec=parent?'同款同规格变体系列':sale.recipe.specification;
  const samePackage=!parent&&sale.recipe.components.length===1&&sale.recipe.components[0].quantity===sale.recipe.components[0].sourcePackPieces;
  const unchangedPackage=samePackage&&product.variants.length===1;
  const componentIds=new Set(sale.recipe.components.map(c=>c.variantId));
  projected.facts=projected.facts.filter(f=>(f.scope===undefined||f.scope==='common'||f.scope==='variant'&&componentIds.size===1&&componentIds.has(f.variantId!))).filter(f=>(unchangedPackage||samePackage&&f.scope!==undefined||!skuDependentSourceFact(f.name))&&!/^颜色|^色系|^color$|^colour$/iu.test(f.name));
  const add=(name:string,value:string)=>{
    const digest=createHash('sha256').update(`${sale.namingGroupId}:${name}`).digest('hex');
    const id=`${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
    projected.facts.push({id,name,value,source:'manual',sourceRef:'销售组合规则',state:'source_confirmed'});
  };
  if(!parent){const count=salesPlatformPieces(sale.recipe);if(count!==null)add('销售件数',String(count));
    for(const c of sale.recipe.components)if(c.unitSemantics){add('销售计量说明',`${c.quantity} ${c.unitSemantics.saleUnit==='kit'?'整套':'待确认单位'}；平台件数${count??'待确认'}；组成 ${c.unitSemantics.contents.map(item=>`${item.name}×${item.quantity??'未知'}`).join('、')}`);}
    if(sale.recipe.color)add('颜色',sale.recipe.color);}
  return projected;
}
