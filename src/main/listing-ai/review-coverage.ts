import type { CandidateField, ListingFieldsReviewOutput } from '../../shared/listing-ai-contracts.ts';
import { AiError } from '../ai/errors.ts';
import { validateListingReviewOutput } from './validation.ts';

export const LISTING_REVIEW_OUTPUT_RULES = `Return exactly {kind:"amazon-fields-review",verdict:"PASS"|"NEEDS_CHANGES"|"BLOCKED",checks:[{field,index,verdict:"SUPPORTED"|"UNSUPPORTED"|"CONTRADICTED",evidenceIds:string[],reason:string,claims:[{text,verdict:"SUPPORTED"|"UNSUPPORTED"|"CONTRADICTED",evidenceIds:string[],reason:string}]}],issues:[{field,message}]}. PASS, NEEDS_CHANGES and BLOCKED are top-level verdicts ONLY; never use them in a check or claim. A check or claim needing correction must be UNSUPPORTED or CONTRADICTED. Cover every supplied item exactly once; index is zero-based within each field. Use at most 12 exact, contiguous claim substrings per item, each at most 500 characters. Together the substrings must cover every word, including connecting words and descriptive wording, with original spelling and case. Copy complete clauses or sentences when useful; do not paraphrase, silently omit words, or invent claims. Assess the meaning of each span against verified evidence; surrounding grammar alone does not need a separate factual claim. Allow ordinary subjective aesthetic wording such as decorative accent, subtle display accent, or a desk/shelf scene when it is grounded in verified decorative/display use; those phrases do not assert measured performance. Cite the supporting product type or use evidence for the complete span rather than demanding a separate source for each adjective or connecting word. Color evidence or an explicit color in the selected SKU specification can support its exact color or faithful translation, including a named gradient or an explicitly joined multicolor list. Random or selectable colors do not identify a definite color, and a named shade is not permission to guess its basic color. Identity, color, material, quantity, size, safety, compatibility and performance still require explicit supporting facts; never let aesthetic wording justify an unsupported functional benefit. Every SUPPORTED item and claim must cite actual evidence IDs supporting its meaning. PASS requires all items and claims SUPPORTED and issues empty; NEEDS_CHANGES or BLOCKED requires specific field issues. Do not rewrite the candidate. Reasons may be Chinese.`;

/** Only the observed negative alias is normalized; strict validation still owns every other value. */
export function negativeReviewAliases(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const root = raw as Record<string, unknown>;
  if (typeof root.verdict !== 'string') throw new AiError('OUTPUT_INVALID');
  if (!Array.isArray(root.checks)) return raw;
  const corrections: { field: unknown; message: unknown }[] = [];
  const checks = root.checks.map(rawCheck => {
    if (!rawCheck || typeof rawCheck !== 'object' || Array.isArray(rawCheck)) return rawCheck;
    const check = rawCheck as Record<string, unknown>;
    if (typeof check.verdict !== 'string') throw new AiError('OUTPUT_INVALID');
    let negative = check.verdict === 'NEEDS_CHANGES', reason = negative ? check.reason : undefined;
    const claims = Array.isArray(check.claims) ? check.claims.map(rawClaim => {
      if (!rawClaim || typeof rawClaim !== 'object' || Array.isArray(rawClaim)) return rawClaim;
      const claim = rawClaim as Record<string, unknown>;
      if (typeof claim.verdict !== 'string') throw new AiError('OUTPUT_INVALID');
      if (claim.verdict !== 'NEEDS_CHANGES') return claim;
      if (!negative) reason = claim.reason;
      negative = true;
      return { ...claim, verdict: 'UNSUPPORTED' };
    }) : check.claims;
    if (!negative) return check;
    corrections.push({ field: check.field, message: reason });
    return { ...check, claims, verdict: check.verdict === 'SUPPORTED' || check.verdict === 'NEEDS_CHANGES' ? 'UNSUPPORTED' : check.verdict };
  });
  if (!corrections.length) return raw;
  if (root.verdict !== 'PASS') return { ...root, checks };
  // A misplaced negative verdict can only lower PASS, never create approval or evidence.
  const originalIssues = root.issues;
  const issues = Array.isArray(originalIssues) ? [...originalIssues, ...corrections.filter(correction => !originalIssues.some(issue =>
    issue && typeof issue === 'object' && !Array.isArray(issue) && issue.field === correction.field))] : originalIssues;
  return { ...root, checks, verdict: 'NEEDS_CHANGES', issues };
}

/** Missing coverage is a reviewer failure, never a product correction or approval. */
export function requireCompleteReview(raw: unknown, copy: { field: CandidateField; values: string[] }[]): ListingFieldsReviewOutput {
  const review = validateListingReviewOutput(negativeReviewAliases(raw));
  for (const item of copy) for (const [index, value] of item.values.entries()) {
    const check = review.checks.find(check => check.field === item.field && check.index === index);
    // The existing assertions still reject missing/extra items and unknown evidence.
    if (!check) continue;
    const covered = new Array<boolean>(value.length).fill(false);
    for (const claim of check.claims) {
      if (!value.includes(claim.text)) throw new AiError('OUTPUT_INVALID');
      for (let at = value.indexOf(claim.text); at >= 0; at = value.indexOf(claim.text, at + 1)) covered.fill(true, at, at + claim.text.length);
    }
    const uncovered = value.split('').map((char, index) => covered[index] ? ' ' : char).join('');
    if (!/[\p{L}\p{N}]/u.test(uncovered.replace(/\b(?:a|an|the|and|or|of|for|in|with|to|on|at|is|are)\b/gi, ''))) continue;
    throw new AiError('OUTPUT_INVALID');
  }
  return validateListingReviewOutput(review);
}
