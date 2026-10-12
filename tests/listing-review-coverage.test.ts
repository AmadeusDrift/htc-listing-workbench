import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requireCompleteReview } from '../src/main/listing-ai/review-coverage.ts';
import { assertListingReview } from '../src/main/listing-ai/validation.ts';

const value = 'A practical nail clipper designed for everyday home use.';
const copy = [{ field: 'product_description' as const, values: [value] }];
const review = () => ({ kind: 'amazon-fields-review', verdict: 'PASS', checks: [{ field: 'product_description', index: 0,
  verdict: 'SUPPORTED', evidenceIds: ['product'], reason: 'Product identity.',
  claims: [{ text: 'nail clipper', verdict: 'SUPPORTED', evidenceIds: ['product'], reason: 'Product identity.' }] }], issues: [] });

test('omitted descriptive wording is a failed review, never a product rewrite request', () => {
  const original=review(),before=structuredClone(original);
  assert.throws(()=>requireCompleteReview(original,copy),(e:any)=>e.code==='OUTPUT_INVALID');
  assert.deepEqual(original,before);
});

test('a complete review is unchanged and a blocking verdict cannot be weakened', () => {
  const complete = review(); complete.checks[0].claims[0].text = value;
  assert.deepEqual(requireCompleteReview(complete, copy), complete);
  const blocked = { ...review(), verdict: 'BLOCKED', issues: [{ field: 'product_description', message: 'Contradiction.' }] };
  blocked.checks[0].verdict = 'CONTRADICTED'; blocked.checks[0].claims[0].text=value;
  const result = requireCompleteReview(blocked, copy);
  assert.equal(result.verdict, 'BLOCKED'); assert.equal(result.checks[0].verdict, 'CONTRADICTED');
});

test('malformed output and invented exact substrings are not repaired', () => {
  const raw = review(); raw.checks[0].claims[0].text = 'Imaginary text';
  assert.throws(() => requireCompleteReview(raw, copy));
  assert.throws(() => requireCompleteReview({ ...review(), extra: 'untrusted' }, copy));
});

test('coverage feedback preserves foreign citations so the independent assertion still rejects them', () => {
  const raw = review(); raw.checks[0].claims[0].text=value; raw.checks[0].claims[0].evidenceIds = ['unknown'];
  const result = requireCompleteReview(raw, copy);
  assert.equal(result.checks[0].claims[0].evidenceIds[0], 'unknown');
  assert.throws(() => assertListingReview(result, { kind: 'amazon-fields', candidates: [{ field: 'product_description', items: [{ value, evidenceIds: ['product'], transformation: 'compose' }] }], missing: [] },
    { fields: [{ name: 'product_description', title: 'Description', requirement: 'required', closedEnum: false, allowedValues: [], suggestedValues: [] }], evidence: [{ id: 'product', name: 'Product type', value: 'nail clipper', meaning: 'general', source: 'human_confirmed' }] }));
});

const capturedReview = () => JSON.parse(readFileSync(new URL('./fixtures/listing-review-needs-changes.json', import.meta.url), 'utf8'));

test('captured negative review retains raw findings but its omitted coverage fails closed', () => {
  const {output,candidate}=capturedReview(),original=structuredClone(output);
  assert.throws(()=>requireCompleteReview(output,candidate.candidates.map((c:any)=>({field:c.field,values:c.items.map((i:any)=>i.value)}))));
  assert.deepEqual(output,original);
});

test('a claim NEEDS_CHANGES alias stays negative without weakening existing blocked or contradicted verdicts', () => {
  const raw = review(); raw.verdict = 'BLOCKED'; raw.checks[0].verdict = 'CONTRADICTED';
  raw.checks[0].claims[0] = { text: value, verdict: 'NEEDS_CHANGES', evidenceIds: ['product'], reason: 'Needs correction.' };
  const input = { ...raw, issues: [{ field: 'product_description', message: 'Correct the unsupported claim.' }] };
  const result = requireCompleteReview(input, copy);
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(result.checks[0].verdict, 'CONTRADICTED');
  assert.deepEqual(result.checks[0].claims[0], { ...input.checks[0].claims[0], verdict: 'UNSUPPORTED' });
  assert.deepEqual(result.issues, input.issues);
});

test('negative alias handling still rejects unknown verdicts, extra keys and missing issues', () => {
  for (const invalid of ['PASS', 'APPROVED', 'FAIL', 'BLOCKED', 'needs_changes', null, ['SUPPORTED']]) {
    const { output } = capturedReview(); output.checks[0].verdict = invalid;
    assert.throws(() => requireCompleteReview(output, []));
    const { output: badClaim } = capturedReview(); badClaim.checks[0].claims[0].verdict = invalid;
    assert.throws(() => requireCompleteReview(badClaim, []));
  }
  const { output } = capturedReview();
  assert.throws(() => requireCompleteReview({ ...output, unexpected: true }, []));
  assert.throws(() => requireCompleteReview({ ...output, verdict: ['NEEDS_CHANGES'] }, []));
  assert.throws(() => requireCompleteReview({ ...output, issues: [] }, []));
});

test('PASS with a negative item or claim alias can only become NEEDS_CHANGES with an actionable issue', () => {
  for (const level of ['check', 'claim'] as const) {
    const raw = review(); raw.checks[0].claims[0].text = value;
    if (level === 'check') { raw.checks[0].verdict = 'NEEDS_CHANGES'; raw.checks[0].reason = 'Remove unsupported wording.'; }
    else { raw.checks[0].claims[0].verdict = 'NEEDS_CHANGES'; raw.checks[0].claims[0].reason = 'Remove unsupported wording.'; }
    const result = requireCompleteReview(raw, copy);
    assert.equal(result.verdict, 'NEEDS_CHANGES');
    assert.equal(result.checks[0].verdict, 'UNSUPPORTED');
    if (level === 'claim') assert.equal(result.checks[0].claims[0].verdict, 'UNSUPPORTED');
    assert.deepEqual(result.issues, [{ field: 'product_description', message: 'Remove unsupported wording.' }]);
    assert.equal(raw.verdict, 'PASS');
  }
});

test('negative alias handling cannot remove invented evidence or claims', () => {
  const { output, candidate } = capturedReview();
  output.checks[0].claims[0].evidenceIds = ['not-in-context'];
  const copy = candidate.candidates.map((c: any) => ({ field: c.field, values: c.items.map((i: any) => i.value) }));
  assert.throws(() => requireCompleteReview(output, copy));
  output.checks[0].claims[0].text = 'Not in the candidate';
  assert.throws(() => requireCompleteReview(output, copy));
});

test('legacy connecting-word omission never creates an unsupported product finding',()=>{
 const raw=review();raw.checks[0].claims[0].text='nail clipper';
 assert.throws(()=>requireCompleteReview(raw,[{field:'product_description',values:['as a nail clipper']}]),(e:any)=>e.code==='OUTPUT_INVALID');
 assert.equal(raw.verdict,'PASS');assert.deepEqual(raw.issues,[]);
});
