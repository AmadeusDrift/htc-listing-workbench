import type { AmazonSchema, JsonObject, ListingIssue } from '../../shared/amazon-contracts.ts';
import type { ListingFieldsOutput } from '../../shared/listing-ai-contracts.ts';
import { isObject } from './context.ts';
import { wrapCandidateValues } from './field-mapping.ts';

export const PROGRAM_RELATION_FIELDS = ['package_level','package_contains_sku','parentage_level','child_parent_sku_relationship','variation_theme'] as const;
export const programRelationField=(field:string)=>(PROGRAM_RELATION_FIELDS as readonly string[]).includes(field);
/** Authorization is deliberately separate from historical parsing/recovery contracts. */
export function authorizeRelationCandidates(raw:ListingFieldsOutput):ListingFieldsOutput {
 const output=structuredClone(raw),blocked=output.candidates.filter(c=>programRelationField(c.field));
 output.candidates=output.candidates.filter(c=>!programRelationField(c.field));
 if(blocked.length){output.rejectedCandidates=[...(output.rejectedCandidates??[]),...blocked];
  for(const c of blocked)output.missing.push({field:c.field,reason:'[PROGRAM_RELATION] 关系字段由程序管理；规格件数不是包装父子关系依据',omitted:true});}
 return output;
}
export function unitPackageAttributes(schema:AmazonSchema,marketplaceId:string):JsonObject {
 if(!isObject(schema.schema.properties)||!schema.schema.properties.package_level)return {};
 return {package_level:wrapCandidateValues(schema,marketplaceId,'package_level',[{value:'unit'}])};
}
export interface PackageNode {sellerId:string;marketplaceId:string;sku:string;attributes:JsonObject}
export function packageGraphIssues(current:PackageNode,others:PackageNode[]):ListingIssue[] {
 const edges=new Map<string,Set<string>>();
 for(const n of [...others.filter(n=>n.sku!==current.sku),current]){
  if(n.sellerId!==current.sellerId||n.marketplaceId!==current.marketplaceId)continue;
  const set=edges.get(n.sku)??new Set<string>();edges.set(n.sku,set);
  for(const edge of Array.isArray(n.attributes.package_contains_sku)?n.attributes.package_contains_sku:[])if(isObject(edge)&&typeof edge.sku==='string'&&(edge.marketplace_id===undefined||edge.marketplace_id===current.marketplaceId))set.add(edge.sku);
 }
 const issue=(code:string,message:string):ListingIssue=>({code,message,attributeNames:['package_contains_sku'],severity:'ERROR',category:'field',source:'local',autoFixable:false});
 if(edges.get(current.sku)?.has(current.sku))return [issue('PACKAGE_SELF_REFERENCE','包装关系不能包含自身 SKU')];
 const visited=new Set<string>(),active=new Set<string>();
 const cycle=(sku:string):boolean=>{if(active.has(sku))return true;if(visited.has(sku))return false;visited.add(sku);active.add(sku);for(const child of edges.get(sku)??[])if(cycle(child))return true;active.delete(sku);return false;};
 return cycle(current.sku)?[issue('PACKAGE_CYCLE','同卖家及站点的包装关系存在循环')]:[];
}
