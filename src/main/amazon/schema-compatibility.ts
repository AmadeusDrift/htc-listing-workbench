import { isDeepStrictEqual } from 'node:util';
import type { AmazonSchema } from '../../shared/amazon-contracts.ts';

/** enumNames is a display annotation paired with enum values, not a value rule.
 * Ignore only this known annotation; every other keyword and meta-schema stays exact. */
const maps=new Set(['properties','patternProperties','$defs','definitions','dependentSchemas','dependencies']);
const schemas=new Set(['items','additionalItems','contains','additionalProperties','unevaluatedProperties','unevaluatedItems','propertyNames','not','if','then','else','contentSchema']);
const lists=new Set(['allOf','anyOf','oneOf','prefixItems']);
function validationContent(value:unknown):unknown {
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  const node=value as Record<string,unknown>;
  const displayNames=Array.isArray(node.enum)&&Array.isArray(node.enumNames)
    &&node.enum.length===node.enumNames.length&&node.enumNames.every(name=>typeof name==='string');
  return Object.fromEntries(Object.entries(node).filter(([key])=>key!=='enumNames'||!displayNames).map(([key,entry])=>{
    if(maps.has(key)&&entry&&typeof entry==='object'&&!Array.isArray(entry))return [key,Object.fromEntries(Object.entries(entry).map(([name,child])=>[name,validationContent(child)]))];
    if(lists.has(key)&&Array.isArray(entry))return [key,entry.map(validationContent)];
    if(schemas.has(key))return [key,Array.isArray(entry)?entry.map(validationContent):validationContent(entry)];
    // const/enum/default/examples contain data, not schemas; never erase their keys.
    return [key,entry];
  }));
}
export function sameSchemaValidation(left:Pick<AmazonSchema,'schema'|'metaSchema'>,right:Pick<AmazonSchema,'schema'|'metaSchema'>):boolean {
  return isDeepStrictEqual(left.metaSchema,right.metaSchema)&&isDeepStrictEqual(validationContent(left.schema),validationContent(right.schema));
}
