import type { ListingAiContext } from '../../shared/listing-ai-contracts.ts';
import { categorySources } from './evidence-contract-v2.ts';
import { parseCategorySource } from './evidence-category-v2.ts';
import { proseClaims } from './evidence-prose-v3.ts';

/** v4 reports explicit contradictions only. Unparsed source wording remains input for AI. */
export function explicitCategoryConflicts(field:string,value:string,context:Pick<ListingAiContext,'evidence'>):string[]{
  const role=field==='target_audience'?'age_range_description':field;
  const typed=['age_range_description','item_firmness_description','power_source_type'].includes(role),candidate=typed?parseCategorySource(role,value):undefined;
  if(candidate?.unparsed)return [];
  const claims=candidate?[...candidate.values.map(value=>({role,value,polarity:'positive',start:0,end:value.length})),...candidate.excluded.map(value=>({role,value,polarity:'negative',start:0,end:value.length}))]:proseClaims(value);
  const compatible=(role:string,a:string,b:string)=>a===b||role==='power_source_type'&&a!=='Manual'&&b!=='Manual'&&(a==='Electric'||b==='Electric')||role==='item_firmness_description'&&[a,b].every(v=>['Soft','Extra Soft'].includes(v));
  return claims.flatMap(claim=>{
    if(claim.polarity==='unparsed')return [];
    const parsed=categorySources(claim.role,context.evidence).map(source=>parseCategorySource(claim.role,source.value));
    if(!parsed.length||parsed.some(source=>source.unparsed||source.unresolved.length))return [];
    const positive=[...new Set(parsed.flatMap(source=>source.values))],excluded=[...new Set(parsed.flatMap(source=>source.excluded))];
    // Conflicting source statements do not establish which side is wrong.
    if(positive.some(v=>excluded.includes(v))||positive.some((a,i)=>positive.slice(i+1).some(b=>!compatible(claim.role,a,b))))return [];
    const contradiction=claim.polarity==='positive'?excluded.includes(claim.value)||positive.length>0&&!positive.some(v=>compatible(claim.role,v,claim.value)):positive.includes(claim.value);
    return contradiction?[`${field}：“${typed?value:value.slice(claim.start,claim.end)}”与明确来源属性 ${claim.role} 冲突（${positive.join(' / ')}${excluded.length?'；明确排除 '+excluded.join(' / '):''}）`]:[];
  });
}
