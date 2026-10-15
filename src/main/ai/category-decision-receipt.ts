import {validDecisionAnswerMetadata} from './adapters/decision-answer-metadata.ts';
/** Validate completed category Decisions answer shape for local history only.
 * This does not establish candidate membership, ownership or retry permission. */
export function validCategoryDecisionAnswers(raw:unknown):boolean {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return false;
 const answers=raw as Record<string,any>;if(Object.keys(answers).sort().join()!=='category,review')return false;
 for(const key of ['category','review']){const answer=answers[key];
  if(!answer||typeof answer!=='object'||Array.isArray(answer)||answer.type!=='choice'||typeof answer.choice!=='string'||!answer.choice||!validDecisionAnswerMetadata(answer))return false;
 }
 return ['clear','review'].includes(answers.review.choice);
}
