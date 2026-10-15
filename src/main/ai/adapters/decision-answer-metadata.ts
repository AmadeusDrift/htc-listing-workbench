/** Metadata validation for a safely received Decisions answer. Keep the
 * original probabilities unchanged; this conveys no dispatch or retry grant. */
export function validDecisionAnswerMetadata(answer:{confidence?:unknown;probabilities?:unknown}):boolean {
 const probability=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
 if(answer.confidence!==undefined&&!probability(answer.confidence))return false;
 const values=answer.probabilities;return values===undefined||!!values&&typeof values==='object'&&!Array.isArray(values)&&Object.values(values).every(probability);
}
