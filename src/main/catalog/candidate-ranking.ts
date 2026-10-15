import type { ProductTypeOption } from '../../shared/amazon-contracts.ts';

export interface CandidateHit { candidate:ProductTypeOption; keyword:string; source:'local'|'platform' }
export interface RankedCandidate extends ProductTypeOption {
  recall:{sources:('local'|'platform')[];keywords:string[];score:number;basis:'exact-name'|'phrase'|'word-overlap'|'platform-result'};
}
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
const normalize=(value:string)=>value.toLowerCase().replace(/[_\s-]+/g,' ').trim();
/** Uses only real names and literal keyword matches, never inferred platform definitions. */
export function candidateRelevance(candidate:ProductTypeOption,keyword:string):{score:number;basis:RankedCandidate['recall']['basis']} {
  const query=normalize(keyword),name=normalize(candidate.name),display=normalize(candidate.displayName);
  if(!query)return {score:0,basis:'word-overlap'};
  if(name===query||display===query)return {score:100,basis:'exact-name'};
  if(name.includes(query)||display.includes(query))return {score:90,basis:'phrase'};
  const words=[...new Set(query.split(' '))],haystack=`${name} ${display}`;
  return {score:Math.round(70*words.filter(word=>haystack.includes(word)).length/words.length),basis:'word-overlap'};
}
/** Merge every discovery before limiting; ordering is independent of keyword/arrival order. */
export function rankCategoryCandidates(hits:readonly CandidateHit[],limit=50):RankedCandidate[] {
  const grouped=new Map<string,CandidateHit[]>();
  for(const hit of hits){const group=grouped.get(hit.candidate.name)??[];group.push(hit);grouped.set(hit.candidate.name,group);}
  return [...grouped].map(([name,group])=>{
    // Conflicting display labels are still real labels. Choose deterministically, never by arrival.
    const displayName=group.map(hit=>hit.candidate.displayName).sort(compare)[0];
    const matches=group.map(hit=>({...candidateRelevance(hit.candidate,hit.keyword),source:hit.source})).sort((a,b)=>b.score-a.score||compare(a.basis,b.basis));
    const best=matches[0];
    return {name,displayName,recall:{sources:[...new Set(group.map(hit=>hit.source))].sort(compare),keywords:[...new Set(group.map(hit=>normalize(hit.keyword)))].sort(compare),score:best.score,basis:best.score===0&&group.some(hit=>hit.source==='platform')?'platform-result' as const:best.basis}};
  }).sort((a,b)=>b.recall.score-a.recall.score||b.recall.keywords.length-a.recall.keywords.length||compare(a.name,b.name)).slice(0,limit);
}
