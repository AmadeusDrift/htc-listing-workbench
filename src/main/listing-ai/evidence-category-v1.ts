/** Immutable parsing used by listing-evidence/v1. Future semantic changes need a new version. */
import { categoryAttributeValues as legacyValues } from './evidence-category-v0.ts';
export { sourceFieldName, categoryAttributeField, categoryAttributeSourceOptions } from './evidence-category-v0.ts';
export function categoryAttributeValues(field:string,value:string):string[]{
  if(field!=='ingredients')return legacyValues(field,value);
  const parts=value.trim().split(/\s*(?:[+＋,，;；、]|\band\b)\s*/iu);
  const translated:Record<string,string>={'洁厕剂':'Toilet Cleaner','香精':'Fragrance','水':'Water','柠檬酸':'Citric Acid'};
  return parts.every(part=>Object.hasOwn(translated,part)||/^[A-Za-z -]+$/.test(part))?[parts.map(part=>Object.hasOwn(translated,part)?translated[part]:part).join(' + ')]:[];
}
