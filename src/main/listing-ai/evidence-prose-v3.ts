/** Immutable finite prose rules for listing-evidence/v3. Source absence retains
 * the existing prose policy; this does not grant inference or manufacture facts. */
import type { CandidateField } from '../../shared/listing-ai-contracts.ts';
import { categoryClauses, parseCategorySource } from './evidence-category-v2.ts';
import { categorySources, decideEvidence } from './evidence-contract-v2.ts';
import type { EvidenceScope } from './evidence-contract-v2.ts';

export const PROSE_FIELDS:readonly CandidateField[]=['item_name','bullet_point','product_description','generic_keyword'];
export const isProseField=(field:CandidateField):boolean=>PROSE_FIELDS.includes(field);
type Role='age_range_description'|'power_source_type'|'item_firmness_description';
interface ProseClaim { role:Role; value:string; polarity:'positive'|'negative'|'unparsed'; start:number; end:number }
export interface ProseEvidenceIssue { field:CandidateField; reason:string; kind:'source'|'citation' }
const terms:{role:Role;pattern:RegExp;value:(match:RegExpExecArray)=>string}[]=[
  {role:'age_range_description',pattern:/\b(?:adults?|child|children|kids?|toddler|baby|babies|infants?)\b/giu,value:m=>/^adult/i.test(m[0])?'Adult':/^(?:baby|babies|infant)/i.test(m[0])?'Baby':'Child'},
  {role:'power_source_type',pattern:/\b(?:corded[ -]electric|battery[ -]powered|hand[ -]powered|manual|electric)\b/giu,value:m=>/^corded/i.test(m[0])?'Corded Electric':/^battery/i.test(m[0])?'Battery Powered':/^electric/i.test(m[0])?'Electric':'Manual'},
  {role:'item_firmness_description',pattern:/\b((?:(?:extra|ultra)[ -])?soft|medium|hard|firm)[ -](?:bristles?|bristled|toothbrush)\b/giu,value:m=>/^(?:extra|ultra)/i.test(m[1])?'Extra Soft':/^soft/i.test(m[1])?'Soft':/^medium/i.test(m[1])?'Medium':'Hard'},
];
const mask=(value:string)=>value.replace(/\b(?:baby[ -](?:blue|shower)|adult[ -]supervision|(?:instruction|instructions|user|owner'?s?)[ -]manual|manual[ -]instructions?)\b/giu,part=>' '.repeat(part.length));
// Only known source terms, with subtypes matched as a single occurrence. The
// frozen parser deduplicates values; a repeated term in its negative clause
// cannot safely inherit the first occurrence's operator (including Chinese).
const sourceTerms:Record<Role,RegExp>={
  age_range_description:/婴幼儿|婴儿|儿童|小孩|幼儿|成人|成年|\b(?:adults?|child|children|kids?|toddler|baby|babies|infants?)\b/giu,
  power_source_type:/有线电动|电池驱动|电池供电|手动|手摇|插电|电动|\b(?:corded[ -]electric|battery[ -]powered|hand[ -]powered|manual|electric)\b/giu,
  item_firmness_description:/超软|极软|软毛|柔软|中毛|中等硬度|硬毛|硬质|\b(?:(?:extra|ultra)[ -]soft|soft|medium|hard|firm)\b/giu,
};
function hasMixedCategoryScope(role:Role,value:string):boolean{
  return categoryClauses(value).some(clause=>parseCategorySource(role,clause).excluded.length>0&&[...clause.matchAll(sourceTerms[role])].length>1);
}

/** Offsets preserve a split review claim's polarity in the original sentence.
 * Each clause is parsed separately; source subtype expansion never adds terms. */
export function proseClaims(value:string):ProseClaim[]{
  const text=mask(value),claims:ProseClaim[]=[];let cursor=0;
  for(const clause of categoryClauses(text)){
    const start=text.indexOf(clause,cursor);cursor=start+clause.length;
    for(const entry of terms){
      const parsed=parseCategorySource(entry.role,clause),matches=[...clause.matchAll(entry.pattern)];
      // Polarity sees every parser term, including "soft handle". Such a term
      // cannot donate its negation to a later bounded "soft bristles" claim.
      const mixed=hasMixedCategoryScope(entry.role,clause);
      for(const match of matches){
        const term=entry.value(match);
        claims.push({role:entry.role,value:term,polarity:parsed.unparsed||mixed?'unparsed':parsed.excluded.includes(term)?'negative':'positive',start:start+match.index!,end:start+match.index!+match[0].length});
      }
    }
  }
  return claims;
}
function touches(claim:ProseClaim,value:string,excerpt:string):boolean{
  for(let at=value.indexOf(excerpt);at>=0;at=value.indexOf(excerpt,at+1))if(at<claim.end&&at+excerpt.length>claim.start)return true;
  return false;
}
export function proseEvidenceIssues(field:CandidateField,value:string,context:EvidenceScope,evidenceIds?:readonly string[],excerpt=value):ProseEvidenceIssue[]{
  if(!isProseField(field))return [];
  const issues:ProseEvidenceIssue[]=[];
  for(const claim of proseClaims(value).filter(claim=>touches(claim,value,excerpt))){
    const sources=categorySources(claim.role,context.evidence);
    const blocked=context.evidenceBlockers?.some(blocker=>blocker.field===claim.role);
    if(!sources.length&&!blocked)continue;
    const parsed=sources.map(source=>({source,parsed:parseCategorySource(claim.role,source.value)}));
    const mixedSource=sources.some(source=>hasMixedCategoryScope(claim.role,source.value));
    let supporting:string[]=[];
    if(!blocked&&!mixedSource&&claim.polarity==='positive'){
      const decision=decideEvidence(claim.role,claim.value,context);
      if(decision.status==='supported')supporting=parsed.filter(entry=>entry.parsed.values.includes(claim.value)).map(entry=>entry.source.id);
    }else if(!blocked&&!mixedSource&&claim.polarity==='negative'){
      const positives=[...new Set(parsed.flatMap(entry=>entry.parsed.values))];
      const exclusions=parsed.flatMap(entry=>entry.parsed.excluded);
      if(!parsed.some(entry=>entry.parsed.unparsed)&&positives.length<=1&&!positives.some(value=>exclusions.includes(value)))
        supporting=parsed.filter(entry=>entry.parsed.excluded.includes(claim.value)).map(entry=>entry.source.id);
    }
    if(!supporting.length)issues.push({field,kind:'source',reason:'文案中的明确分类声明缺少一致的对应来源支持'});
    else if(evidenceIds&&!supporting.some(id=>evidenceIds.includes(id)))issues.push({field,kind:'citation',reason:'文案中的分类声明需要引用其实际 SKU 或来源属性'});
  }
  return issues;
}
