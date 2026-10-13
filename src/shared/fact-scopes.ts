import type { Fact, ProductDetail } from './contracts.ts';
/** Missing scope is the historical product-wide interpretation; never persist it as a new confirmation. */
export function factsForVariant(product:Pick<ProductDetail,'facts'>,variantId:string):Fact[]{
  return product.facts.filter(f=>f.scope===undefined||f.scope==='common'||f.scope==='variant'&&f.variantId===variantId);
}

/** Classification describes the product link, not a selected SKU. Keep variant and unknown evidence visibly separate. */
export function productFactEvidence(product:Pick<ProductDetail,'facts'>){
  const confirmed=product.facts.filter(f=>['source_confirmed','human_confirmed'].includes(f.state));
  const plain=({name,value}:Fact)=>({name,value});
  return {facts:confirmed.filter(f=>f.scope===undefined||f.scope==='common').map(plain),
    ...(product.facts.some(f=>f.scope!==undefined)?{
      variantFacts:confirmed.filter(f=>f.scope==='variant').map(f=>({...plain(f),variantId:f.variantId,scope:'variant' as const})),
      unknownFacts:product.facts.filter(f=>f.scope==='unknown').map(f=>({...plain(f),scope:'unknown' as const,state:f.state})),
      factScopeNote:'facts are common or historical unscoped evidence. variantFacts apply only to their variantId; unknownFacts have unconfirmed applicability and are not authoritative for all SKUs.',
    }:{}),};
}
