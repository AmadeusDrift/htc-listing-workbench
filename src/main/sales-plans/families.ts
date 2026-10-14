import type { AmazonSchema, JsonObject } from '../../shared/amazon-contracts.ts';
import type { SalesListingPlan, SalesRecipe } from '../../shared/sales-plan-contracts.ts';
import { isObject } from '../amazon/context.ts';
import { resolveSchemaNode } from '../amazon/field-catalog.ts';
import { wrapCandidateValues } from '../amazon/field-mapping.ts';
import { salesPlatformPieces } from '../../shared/source-quantity.ts';

/** Only concrete supported dimensions are used; unrelated axes are never invented. */
export function chooseVariationTheme(schema:AmazonSchema, recipes:SalesRecipe[]):string|null {
  if(recipes.length<2||new Set(recipes.map(r=>r.groupKey)).size!==1) return null;
  const properties=schema.schema.properties;
  if(!isObject(properties)||!isObject(properties.variation_theme)||!properties.parentage_level||!properties.child_parent_sku_relationship) return null;
  const field=resolveSchemaNode(schema.schema,properties.variation_theme),item=resolveSchemaNode(schema.schema,field.items);
  if(!isObject(item.properties)||!isObject(item.properties.name)) return null;
  const name=resolveSchemaNode(schema.schema,item.properties.name),themes=Array.isArray(name.enum)?name.enum.filter((v):v is string=>typeof v==='string'):[];
  const deprecated=new Set([field,item,name].flatMap(n=>isObject(n.$lifecycle)&&Array.isArray(n.$lifecycle.enumDeprecated)?n.$lifecycle.enumDeprecated:[]));
  const countVaries=new Set(recipes.map(salesPlatformPieces)).size>1;
  const colorVaries=new Set(recipes.map(r=>r.color)).size>1;
  const usable=themes.filter(theme=>{
    const axes=theme.split('/'),hasColor=axes.some(axis=>['COLOR','COLOR_NAME'].includes(axis)),hasCount=axes.includes('NUMBER_OF_ITEMS');
    return !deprecated.has(theme)&&axes.length>0
      &&axes.every(axis=>['COLOR','COLOR_NAME','NUMBER_OF_ITEMS'].includes(axis))&&(!countVaries||hasCount)&&(!colorVaries||hasColor)
      &&(!hasColor||recipes.every(r=>!!r.color))
      &&(!hasCount||recipes.every(r=>salesPlatformPieces(r)!==null))
      &&new Set(recipes.map(r=>JSON.stringify([...(hasColor?[r.color]:[]),...(hasCount?[salesPlatformPieces(r)]:[])]))).size===recipes.length;
  });
  return usable.sort((a,b)=>a.split('/').length-b.split('/').length||a.localeCompare(b))[0]??null;
}
export function relationshipAttributes(schema:AmazonSchema,plan:SalesListingPlan,marketplaceId='ATVPDKIKX0DER'):JsonObject {
  if(plan.parentage==='NONE') return {};
  const properties=schema.schema.properties;
  if(!isObject(properties)||!properties.variation_theme||!properties.parentage_level||!properties.child_parent_sku_relationship) throw new Error('当前 Schema 不支持已规划的父子体关系');
  return {parentage_level:wrapCandidateValues(schema,marketplaceId,'parentage_level',[{value:plan.parentage==='PARENT'?'parent':'child'}]),
    variation_theme:wrapCandidateValues(schema,marketplaceId,'variation_theme',[{name:plan.variationTheme!}]),
    child_parent_sku_relationship:wrapCandidateValues(schema,marketplaceId,'child_parent_sku_relationship',[{child_relationship_type:'variation',...(plan.parentage==='CHILD'?{parent_sku:plan.parentSku!}:{})}])};
}
