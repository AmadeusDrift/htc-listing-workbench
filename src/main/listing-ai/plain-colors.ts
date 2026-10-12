import type { JsonValue } from '../../shared/amazon-contracts.ts';

/** Display naming only. Never apply to source specifications, prose or saved AI responses. */
export function plainColorName(value:string,sources:readonly string[]=[]):string {
  const trimmed=value.trim();
  if(/^(?:樱花粉色?|cherry blossom pink|sakura pink)$/i.test(trimmed))return 'Pink';
  // Sakura alone names a flower, not a hue. Only the selected color evidence can
  // establish pink; absence of that evidence is not a new rejection condition.
  if(/^sakura$/i.test(trimmed)&&sources.some(source=>/樱花粉|cherry blossom pink|sakura pink/i.test(source)))return 'Pink';
  return value;
}

/** Preserve selectors and all non-value leaves in the platform's color wrapper. */
export function plainColorValue(value:JsonValue,sources:readonly string[]=[]):JsonValue {
  if(typeof value==='string')return plainColorName(value,sources);
  if(Array.isArray(value))return value.map(item=>plainColorValue(item,sources));
  if(value&&typeof value==='object')return {...value,...(typeof value.value==='string'?{value:plainColorName(value.value,sources)}:{})};
  return value;
}
