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
    return {name,displayName,recall:{sources:[...new Set(group.map(hit=>hit.source))].sort(compare),keywords:[...new Set(group.map(hit=>normalize(hit.keyword)).filter(Boolean))].sort(compare),score:best.score,basis:best.score===0&&group.some(hit=>hit.source==='platform')?'platform-result' as const:best.basis}};
  }).sort((a,b)=>b.recall.score-a.recall.score||b.recall.keywords.length-a.recall.keywords.length||compare(a.name,b.name)).slice(0,limit);
}
/** Expanded platform recall must add actual new options, including zero lexical matches.
 * This reserves visibility, not suitability or confidence. */
export function rankExpandedCategoryCandidates(hits:readonly CandidateHit[],originalNames:readonly string[]):RankedCandidate[] {
  const ranked=rankCategoryCandidates(hits,Number.MAX_SAFE_INTEGER),original=new Set(originalNames);
  const novel=ranked.filter(candidate=>!original.has(candidate.name)&&candidate.recall.sources.includes('platform'));
  if(!novel.length)return [];
  const selected=new Set(novel.slice(0,50).map(candidate=>candidate.name));
  for(const candidate of ranked){if(selected.size===50)break;selected.add(candidate.name);}
  return ranked.filter(candidate=>selected.has(candidate.name));
}
export function categoryExpansionQuery(keywords:readonly string[]):string {
  const selected:string[]=[];
  for(const keyword of [...new Set(keywords.map(normalize))].sort(compare)){
    if(!keyword)continue;if([...selected,keyword].join(' ').length>200)continue;selected.push(keyword);
  }
  return selected.join(' ');
}
