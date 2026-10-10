import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suggestListingFields } from '../src/main/ai/listing-adapters.ts';
import type { CandidateField, ListingAiContext, ListingEvidence, ListingFieldCard } from '../src/shared/listing-ai-contracts.ts';
import type { JsonValue } from '../src/shared/amazon-contracts.ts';
import { assertListingEvidence, listingFingerprint, validateListingFieldsOutput } from '../src/main/listing-ai/validation.ts';
import { assertListingEvidence as assertFrozenV3Evidence, validateListingFieldsOutput as validateFrozenV3Output } from '../src/main/listing-ai/evidence-validation-v3.ts';

const field = (name: CandidateField, allowedValues?: JsonValue[]): ListingFieldCard => ({ name, title: name, requirement: 'required', closedEnum: allowedValues !== undefined, allowedValues: allowedValues ?? [], suggestedValues: [] });
const fact = (id: string, name: string, value: string, meaning: ListingEvidence['meaning'] = 'general'): ListingEvidence => ({ id, name, value, meaning, source: 'source_confirmed' });
function context(fields: ListingFieldCard[], evidence: ListingEvidence[]): ListingAiContext {
  return { draftId: randomUUID(), draftRevision: 1, productId: randomUUID(), productRevision: 1, variantId: randomUUID(), sku: 'SYNTHETIC-FORMAT', targetId: randomUUID(), targetGeneration: 1,
    listingProgram: 'haul', productType: 'STORAGE_BOX', marketplaceId: 'ATVPDKIKX0DER', locale: 'en_US', requirements: 'LISTING', parentageLevel: 'NONE', schemaChecksum: 'synthetic', schemaVersion: '1', schemaSha256: 'a'.repeat(64), policyVersion: 'haul-us-copy-2026-10-07-v2', fields, evidence, unverifiedSourceTitle: '' };
}
const item = (name: CandidateField, value: unknown, evidenceIds: string[]) => ({ field: name, items: [{ value, evidenceIds, transformation: 'translate' }] });
const response = (candidates: unknown[], missing: unknown[] = []) => ({ kind: 'amazon-fields', candidates, missing });
async function generate(c: ListingAiContext, raw: unknown) {
  const before = JSON.stringify(raw), result = await suggestListingFields(c, 'deepseek-flash', { apiKey: 'synthetic-format-key' }, new AbortController().signal, {
    now: () => new Date('2026-10-10T00:00:00.000Z'), nonce: randomUUID, maxResponseBytes: 200000,
    fetch: async () => new Response(JSON.stringify({ id: 'synthetic-format-response', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })),
  });
  assert.equal(JSON.stringify(raw), before, 'new-response normalization must not mutate the supplied response');
  return result;
}

test('new transport response normalizes finite ASCII width and outer whitespace with exact raw provenance', async () => {
  const rawValue = '　Ｓｉｌｉｃｏｎｅ　', c = context([field('material', ['Silicone'])], [fact('material-source', '材质', '硅胶', 'material')]);
  const result = await generate(c, response([item('material', rawValue, ['material-source'])]));
  assert.equal(result.output.candidates[0].items[0].value, 'Silicone');
  assert.deepEqual((result as any).listingNormalization, { version: 'listing-normalization/v1', entries: [{ field: 'material', index: 0, rawValue, value: 'Silicone', ruleIds: ['ascii-width', 'trim'], evidenceIds: ['material-source'] }] });
});

test('new transport response maps only to the exact unique schema enum spelling', async () => {
  const c = context([field('color', ['Blue', 'Red'])], [fact('color-source', '颜色', '蓝色', 'color')]);
  const result = await generate(c, response([item('color', 'blue', ['color-source'])]));
  assert.equal(result.output.candidates[0].items[0].value, 'Blue');
  assert.deepEqual((result as any).listingNormalization.entries[0].ruleIds, ['schema-enum']);
});

test('new transport response canonicalizes a boolean literal without losing false', async () => {
  const c = context([field('contains_liquid_contents', [false, true])], [fact('liquid-source', '是否含液体', '否')]);
  const result = await generate(c, response([item('contains_liquid_contents', ' ＦＡＬＳＥ ', ['liquid-source'])]));
  assert.equal(result.output.candidates[0].items[0].value, 'false');
  assert.deepEqual((result as any).listingNormalization.entries[0].ruleIds, ['ascii-width', 'trim', 'boolean-literal']);
});

test('new transport response maps fabric N/A only with permitted schema and explicit non-textile evidence', async () => {
  const c = context([field('fabric_type', ['Not Applicable'])], [fact('material-source', '材质', 'PLA', 'material')]);
  const result = await generate(c, response([item('fabric_type', 'N/A', ['material-source'])]));
  assert.equal(result.output.candidates[0].items[0].value, 'Not Applicable');
  assert.deepEqual((result as any).listingNormalization.entries[0].ruleIds, ['fabric-not-applicable']);
});

test('repair keeps a normalized candidate and its trace while isolating an unsupported candidate', async () => {
  const c = context([field('color', ['Blue']), field('material')], [fact('color-source', '颜色', '蓝色', 'color'), fact('material-source', '材质', '硅胶', 'material')]);
  c.repairRequest = { issues: [], currentValues: {} };
  const result = await generate(c, response([item('color', '　ｂｌｕｅ　', ['color-source']), item('material', 'Plastic', ['material-source'])]));
  assert.deepEqual(result.output.candidates.map(candidate => [candidate.field, candidate.items[0].value]), [['color', 'Blue']]);
  assert.equal(result.output.missing[0].field, 'material');
  assert.match(result.output.missing[0].reason, /已保留其他合格字段/);
  assert.equal((result as any).listingNormalization.entries.length, 1);
  assert.equal((result as any).listingNormalization.entries[0].field, 'color');
});

for (const [label, value, options] of [
  ['case collision', 'blue', ['Blue', 'BLUE']],
  ['trim collision', ' Blue ', ['Blue', 'BLUE']],
  ['width collision', 'Ｂｌｕｅ', ['Blue', 'BLUE']],
  ['unknown enum', 'Purple', ['Blue', 'Red']],
  ['fixed enum with a different fact', 'Red', ['Blue']],
] as const) test(`new response refuses ${label}`, async () => {
  const c = context([field('color', [...options])], [fact('color-source', '颜色', '蓝色', 'color')]);
  await assert.rejects(generate(c, response([item('color', value, ['color-source'])])), { code: 'OUTPUT_INVALID' });
});

test('an exact schema literal survives even when normalized enum keys collide', async () => {
  const c = context([field('color', ['Blue', 'BLUE'])], [fact('color-source', '颜色', '蓝色', 'color')]);
  const result = await generate(c, response([item('color', 'Blue', ['color-source'])]));
  assert.equal(result.output.candidates[0].items[0].value, 'Blue');
  assert.equal(Object.hasOwn(result, 'listingNormalization'), false);
});

test('fullwidth ASCII and trim never fold Roman or circled numerals or collapse interior whitespace', async () => {
  const c = context([field('item_name')], [fact('category-source', '产品类型', 'Series Ⅳ ① X')]), original = structuredClone(c), hash = listingFingerprint(c);
  const result = await generate(c, response([item('item_name', ' Series Ⅳ ①  Ｘ ', ['category-source'])]));
  assert.equal(result.output.candidates[0].items[0].value, 'Series Ⅳ ①  X');
  assert.deepEqual(c, original); assert.equal(listingFingerprint(c), hash);
});

test('native false has provenance while canonical false and a textual zero remain present', async () => {
  const c = context([field('contains_liquid_contents', [false])], [fact('liquid-source', '是否含液体', '否')]);
  const native = await generate(c, response([item('contains_liquid_contents', false, ['liquid-source'])]));
  assert.equal(native.output.candidates[0].items[0].value, 'false');
  assert.equal(native.listingNormalization!.entries[0].rawValue, false);
  assert.deepEqual(native.listingNormalization!.entries[0].ruleIds, ['boolean-literal']);
  const canonical = await generate(c, response([item('contains_liquid_contents', 'false', ['liquid-source'])]));
  assert.equal(canonical.output.candidates[0].items[0].value, 'false'); assert.equal(Object.hasOwn(canonical, 'listingNormalization'), false);
  const zeroContext = context([field('item_name')], [fact('category-source', '产品类型', '0')]);
  const zero = await generate(zeroContext, response([item('item_name', '0', ['category-source'])]));
  assert.equal(zero.output.candidates[0].items[0].value, '0'); assert.equal(Object.hasOwn(zero, 'listingNormalization'), false);
  await assert.rejects(generate(zeroContext, response([item('item_name', 0, ['category-source'])])), { code: 'OUTPUT_INVALID' });
});

test('an exact native boolean enum stays valid beside its string representation', async () => {
  for (const value of [false, true]) {
    const c = context([field('contains_liquid_contents', [value, String(value)])], [fact('source', '是否含液体', value ? '是' : '否')]);
    const raw = response([item('contains_liquid_contents', value, ['source'])]);
    assert.doesNotThrow(() => assertListingEvidence(validateListingFieldsOutput(raw), c));
    const result = await generate(c, raw);
    assert.equal(result.output.candidates[0].items[0].value, String(value));
    assert.equal(result.listingNormalization!.entries[0].rawValue, value);
    assert.deepEqual(result.listingNormalization!.entries[0].ruleIds, ['boolean-literal']);
  }
});

for (const value of [false, true]) for (const repair of [false, true]) test(`canonical string enum preserves native ${value} in ${repair ? 'repair' : 'generation'}`, async () => {
  const canonical = String(value), alternate = repair ? ` ${canonical.toUpperCase()} ` : canonical.toUpperCase();
  const c = context([field('contains_liquid_contents', [canonical, alternate]), field('material')], [fact('source', '是否含液体', value ? '是' : '否'), fact('material-source', '材质', '硅胶', 'material')]);
  if (repair) c.repairRequest = { issues: [], currentValues: {} };
  const raw = response([item('contains_liquid_contents', value, ['source']), item('material', 'Silicone', ['material-source'])]);
  const baseline = validateFrozenV3Output(raw); assertFrozenV3Evidence(baseline, c);
  assert.equal(baseline.candidates[0].items[0].value, canonical);
  const result = await generate(c, raw);
  assert.deepEqual(result.output, baseline);
  assert.deepEqual(result.listingNormalization, { version: 'listing-normalization/v1', entries: [{ field: 'contains_liquid_contents', index: 0, rawValue: value, value: canonical, ruleIds: ['boolean-literal'], evidenceIds: ['source'] }] });
});

for (const value of [false, true]) test(`nonexact ${value} text still rejects ambiguous enum spelling in generation and repair`, async () => {
  const canonical = String(value), c = context([field('contains_liquid_contents', [canonical, canonical.toUpperCase()]), field('material')], [fact('source', '是否含液体', value ? '是' : '否'), fact('material-source', '材质', '硅胶', 'material')]);
  for (const rawValue of [` ${canonical} `, canonical.replace(/[a-z]/g, char => String.fromCharCode(char.charCodeAt(0) + 0xFEE0))]) {
    const raw = response([item('contains_liquid_contents', rawValue, ['source']), item('material', 'Silicone', ['material-source'])]);
    delete c.repairRequest;
    await assert.rejects(generate(c, raw), { code: 'OUTPUT_INVALID' });
    c.repairRequest = { issues: [], currentValues: {} };
    const result = await generate(c, raw);
    assert.deepEqual(result.output.candidates.map(candidate => candidate.field), ['material']);
    assert.match(result.output.missing[0].reason, /多个 Schema 枚举选项/);
    assert.equal(result.output.missing[0].field, 'contains_liquid_contents');
    assert.equal(Object.hasOwn(result, 'listingNormalization'), false);
  }
});

for (const rawValue of ['0', 'no', 'yes', 0, null, '', '   ']) test(`boolean normalization does not infer ${JSON.stringify(rawValue)}`, async () => {
  const c = context([field('contains_liquid_contents', [false])], [fact('liquid-source', '是否含液体', '否')]);
  await assert.rejects(generate(c, response([item('contains_liquid_contents', rawValue, ['liquid-source'])])), { code: 'OUTPUT_INVALID' });
});

for (const material of ['Cotton', 'PLA and cotton', '']) test(`fabric N/A conversion does not invent non-textile support from ${JSON.stringify(material)}`, async () => {
  const evidence = material ? fact('source', '材质', material, 'material') : fact('source', '产品类型', 'Box');
  await assert.rejects(generate(context([field('fabric_type', ['Not Applicable'])], [evidence]), response([item('fabric_type', 'N/A', ['source'])])), { code: 'OUTPUT_INVALID' });
});

test('fabric mappings require one real option and do not clear a legal schema N/A', async () => {
  const evidence = [fact('source', '材质', 'PLA', 'material')];
  for (const options of [['Unknown'], ['Not Applicable', 'not_applicable']]) await assert.rejects(generate(context([field('fabric_type', options)], evidence), response([item('fabric_type', 'N/A', ['source'])])), { code: 'OUTPUT_INVALID' });
  const result = await generate(context([field('fabric_type', ['N/A'])], evidence), response([item('fabric_type', 'N/A', ['source'])]));
  assert.equal(result.output.candidates[0].items[0].value, 'N/A'); assert.equal(Object.hasOwn(result, 'listingNormalization'), false);
  await assert.rejects(generate(context([field('material', ['Not Applicable'])], evidence), response([item('material', 'N/A', ['source'])])), { code: 'OUTPUT_INVALID' });
});

test('normalization does not grant evidence authority for mismatches, blockers, or another SKU', async () => {
  const c = context([field('material', ['Plastic', 'Silicone'])], [fact('source', '材质', '硅胶', 'material')]);
  await assert.rejects(generate(c, response([item('material', ' plastic ', ['source'])])), { code: 'OUTPUT_INVALID' });
  c.evidenceBlockers = [{ field: 'material', reason: 'source_conflict', facts: [{ id: 'conflict', name: '材质', value: 'Plastic' }] }];
  await assert.rejects(generate(c, response([item('material', ' silicone ', ['source'])])), { code: 'OUTPUT_INVALID' });
  const sibling = context([field('color', ['Blue'])], [{ ...fact('another-sku:color', 'Selected SKU color', 'Blue', 'color'), source: 'selected_sku' }]);
  await assert.rejects(generate(sibling, response([item('color', ' blue ', ['another-sku:color'])])), { code: 'OUTPUT_INVALID' });
});

test('provider metadata, unknown keys, missing reasons and illegal fields cannot be normalized away', async () => {
  const c = context([field('material')], [fact('source', '材质', '硅胶', 'material')]), valid = response([item('material', ' Silicone ', ['source'])]);
  for (const raw of [
    { ...valid, listingNormalization: { version: 'listing-normalization/v1', entries: [] } },
    { ...valid, unexpected: true },
    response([{ ...item('material', ' Silicone ', ['source']), unknown: true }]),
    response([{ field: 'material', items: [{ value: ' Silicone ', evidenceIds: ['source'], transformation: 'translate', listingNormalization: {} }] }]),
    response([{ ...item('material', ' Silicone ', ['source']), field: 'brand' }]),
    response([], [{ field: 'material' }]),
    response([item('material', ' Silicone\u000b', ['source'])]),
  ]) await assert.rejects(generate(c, raw), { code: 'OUTPUT_INVALID' });
  c.repairRequest = { issues: [], currentValues: {} };
  for (const raw of [{ ...valid, listingNormalization: {} }, response([], [{ field: 'material' }]), response([{ ...item('material', ' Silicone ', ['source']), field: 'brand' }])]) await assert.rejects(generate(c, raw), { code: 'OUTPUT_INVALID' });
});

test('repair drops traces from normalized-but-rejected values and preserves explicit missing reasons', async () => {
  const c = context([field('color', ['Blue']), field('material'), field('fabric_type')], [fact('color-source', '颜色', '蓝色', 'color'), fact('material-source', '材质', '硅胶', 'material')]);
  c.repairRequest = { issues: [], currentValues: {} };
  const result = await generate(c, response([item('color', ' Blue ', ['color-source']), item('material', ' Plastic ', ['material-source'])], [{ field: 'fabric_type', reason: 'Source is incomplete; keep this reason.' }]));
  assert.deepEqual(result.output.candidates.map(candidate => candidate.field), ['color']);
  assert.deepEqual(result.listingNormalization!.entries.map(entry => entry.field), ['color']);
  assert.equal(result.output.missing.find(item => item.field === 'fabric_type')!.reason, 'Source is incomplete; keep this reason.');
});

test('the shared parser and strict evidence validator retain the original stored rules', () => {
  const raw = response([item('color', ' blue ', ['source'])]), c = context([field('color', ['Blue'])], [fact('source', '颜色', '蓝色', 'color')]);
  const stored = validateListingFieldsOutput(raw);
  assert.equal(stored.candidates[0].items[0].value, ' blue ');
  assert.throws(() => assertListingEvidence(stored, c));
  assert.throws(() => validateListingFieldsOutput(response([item('contains_liquid_contents', 'FALSE', ['source'])])));
});

test('repair validates normalized length and leaves explicit missing fields unfilled', async () => {
  const c = context([{ ...field('color', ['Blue']), maxLength: 3 }, field('is_expiration_dated_product', [false])], [fact('source', '颜色', 'Blue', 'color')]);
  c.repairRequest = { issues: [], currentValues: {} };
  const result = await generate(c, response([item('color', ' Blue ', ['source'])], [{ field: 'is_expiration_dated_product', reason: 'No expiration-status evidence.' }]));
  assert.deepEqual(result.output.candidates, []); assert.equal(Object.hasOwn(result, 'listingNormalization'), false);
  assert.match(result.output.missing.find(entry => entry.field === 'color')!.reason, /长度/);
  assert.equal(result.output.missing.find(entry => entry.field === 'is_expiration_dated_product')!.reason, 'No expiration-status evidence.');
});

test('format conversion preserves explicit inference metadata and never creates missing inference permission', async () => {
  const c = context([field('item_form', ['Solid'])], [fact('source', '材质', '塑料', 'material')]);
  const candidate = { field: 'item_form', items: [{ value: ' solid ', evidenceIds: ['source'], transformation: 'infer', inferenceReason: 'Solid plastic product judgment, not a measured property.' }] };
  const result = await generate(c, response([candidate]));
  assert.equal(result.output.candidates[0].items[0].transformation, 'infer');
  assert.equal(result.output.candidates[0].items[0].inferenceReason, candidate.items[0].inferenceReason);
  await assert.rejects(generate(c, response([item('item_form', ' solid ', ['source'])])), { code: 'OUTPUT_INVALID' });
});
