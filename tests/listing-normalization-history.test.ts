import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, chat, candidateFor, reviewFor, mockStorage, saveInput } from './fixtures/listing-ai.ts';
import { validateAiResult, validateStoredAiResult } from '../src/main/ai/validation.ts';
import { openDatabase } from '../src/main/database.ts';
import { AiService } from '../src/main/ai/service.ts';
import { assertListingHistory } from '../src/main/listing-ai/history.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { join } from 'node:path';
import { buildListingContext } from '../src/main/listing-ai/context.ts';
import { randomUUID } from 'node:crypto';

function formatted(payload: any) {
  const output = candidateFor(payload);
  output.candidates.find((candidate: any) => candidate.field === 'material').items[0].value = ' Silicone ';
  return output;
}

test('main process persists normalization outside the candidate output and preserves it when reading', async t => {
  const f = await fixture(t); f.respond(payload => chat(formatted(payload)));
  const result = await f.listing.suggest(f.reference), trace = (result as any).listingNormalization;
  assert.ok(trace, 'normalization provenance must survive the main-process result boundary');
  assert.equal(result.output.kind, 'amazon-fields');
  assert.deepEqual(trace.entries.map((entry: any) => [entry.field, entry.index, entry.rawValue, entry.value, entry.ruleIds]), [['material', 0, ' Silicone ', 'Silicone', ['trim']]]);
  assert.equal(Object.hasOwn(result.output, 'listingNormalization'), false);
  assert.deepEqual(f.ai.getResult(result.id), result);
});

test('valid optional outer normalization trace is accepted by current and stored result validation', async t => {
  const f = await fixture(t), result: any = structuredClone(await f.listing.suggest(f.reference));
  const candidate = result.output.candidates.find((candidate: any) => candidate.field === 'material').items[0];
  result.listingNormalization = { version: 'listing-normalization/v1', entries: [{ field: 'material', index: 0, rawValue: ' Silicone ', value: 'Silicone', ruleIds: ['trim'], evidenceIds: candidate.evidenceIds }] };
  assert.deepEqual(validateAiResult(result), result);
  assert.deepEqual(validateStoredAiResult(result), result);
});

test('canonical string enum boolean traces persist and replay across main-process restart', async t => {
  for (const value of [false, true]) {
    const canonical = String(value), schema = { type: 'array', items: { type: 'object', properties: { value: { type: 'string', enum: [canonical, canonical.toUpperCase()] }, marketplace_id: { type: 'string' } }, required: ['value'], additionalProperties: false } };
    const f = await fixture(t, { contains_liquid_contents: schema });
    const product = f.store.saveProduct({ ...saveInput(f.product), facts: [...f.product.facts, { id: randomUUID(), name: '是否含液体', value: value ? '是' : '否', source: 'manual', sourceRef: 'synthetic-boolean', state: 'human_confirmed' }] });
    const draft = await f.amazon.createDraft({ productId: product.id, variantId: product.variants[0].id, targetId: f.draft.targetId, productType: f.draft.schema.productType, parentageLevel: f.draft.schema.parentageLevel, requirements: f.draft.schema.requirements, locale: f.draft.schema.locale });
    draft.schema.schema.required = [...(draft.schema.schema.required as string[]), 'contains_liquid_contents'];
    const context = buildListingContext(draft, product, 1);
    context.fields = context.fields.filter(field => field.name === 'contains_liquid_contents');
    assert.equal(context.fields.length, 1);
    const source = context.evidence.find(evidence => evidence.name === '是否含液体')!;
    assert.ok(source);
    f.respond(() => chat({ kind: 'amazon-fields', candidates: [{ field: 'contains_liquid_contents', items: [{ value, evidenceIds: [source.id], transformation: 'translate' }] }], missing: [] }));
    const records = [];
    for (const repair of [false, true]) {
      if (repair) context.repairRequest = { issues: [], currentValues: {} };
      const result = await f.ai.listingFields(context, async () => {});
      assert.deepEqual(result.listingNormalization, { version: 'listing-normalization/v1', entries: [{ field: 'contains_liquid_contents', index: 0, rawValue: value, value: canonical, ruleIds: ['boolean-literal'], evidenceIds: [source.id] }] });
      assert.deepEqual(f.ai.getResult(result.id), result);
      assert.deepEqual(validateStoredAiResult(result), result);
      const ambiguous = structuredClone(result); ambiguous.listingNormalization!.entries[0].rawValue = ` ${canonical} `;
      assert.throws(() => validateStoredAiResult(ambiguous), 'a boolean trace cannot authorize an ambiguous formatted string');
      records.push(result);
    }
    await f.ai.close(); let requests = 0;
    const restarted = new AiService(f.directory, f.store, f.hosting, mockStorage, { fetch: async () => { requests++; throw Error('Unexpected provider call'); } });
    try { for (const record of records) assert.deepEqual(restarted.getResult(record.id), record); assert.equal(requests, 0); } finally { await restarted.close(); }
  }
});

test('normalization provenance is strictly bound to version, real conversions, field, index and evidence', async t => {
  const f = await fixture(t); f.respond(payload => chat(formatted(payload)));
  const result = await f.listing.suggest(f.reference);
  const mutations: [string, (result: any) => void][] = [
    ['unknown version', value => { value.listingNormalization.version = 'listing-normalization/v2'; }],
    ['unknown root key', value => { value.listingNormalization.trusted = true; }],
    ['unknown entry key', value => { value.listingNormalization.entries[0].approved = true; }],
    ['empty entries', value => { value.listingNormalization.entries = []; }],
    ['duplicate entry', value => { value.listingNormalization.entries.push(structuredClone(value.listingNormalization.entries[0])); }],
    ['field mismatch', value => { value.listingNormalization.entries[0].field = 'color'; }],
    ['illegal field', value => { value.listingNormalization.entries[0].field = 'brand'; }],
    ['wrong index', value => { value.listingNormalization.entries[0].index = 1; }],
    ['negative index', value => { value.listingNormalization.entries[0].index = -1; }],
    ['string index', value => { value.listingNormalization.entries[0].index = '0'; }],
    ['changed output', value => { value.listingNormalization.entries[0].value = 'Plastic'; }],
    ['no conversion', value => { value.listingNormalization.entries[0].rawValue = 'Silicone'; }],
    ['invented conversion', value => { value.listingNormalization.entries[0].rawValue = ' Plastic '; }],
    ['zero is not coerced', value => { value.listingNormalization.entries[0].rawValue = 0; }],
    ['object raw value', value => { value.listingNormalization.entries[0].rawValue = { value: 'Silicone' }; }],
    ['overlong raw text', value => { value.listingNormalization.entries[0].rawValue = ' '.repeat(2001) + 'Silicone'; }],
    ['missing rule', value => { value.listingNormalization.entries[0].ruleIds = []; }],
    ['wrong rule', value => { value.listingNormalization.entries[0].ruleIds = ['schema-enum']; }],
    ['unknown rule', value => { value.listingNormalization.entries[0].ruleIds = ['invent']; }],
    ['extra rule', value => { value.listingNormalization.entries[0].ruleIds.push('ascii-width'); }],
    ['wrong evidence', value => { value.listingNormalization.entries[0].evidenceIds = ['other']; }],
    ['empty evidence', value => { value.listingNormalization.entries[0].evidenceIds = []; }],
    ['missing final candidate', value => { value.output.candidates = value.output.candidates.filter((candidate: any) => candidate.field !== 'material'); }],
    ['legacy marker', value => { delete value.listingEvidenceContractVersion; }],
    ['v1 marker', value => { value.listingEvidenceContractVersion = 'listing-evidence/v1'; }],
    ['v2 marker', value => { value.listingEvidenceContractVersion = 'listing-evidence/v2'; }],
  ];
  for (const [label, mutate] of mutations) {
    const bad = structuredClone(result); mutate(bad);
    assert.throws(() => validateAiResult(bad), label);
    assert.throws(() => validateStoredAiResult(bad), `stored: ${label}`);
  }
  f.respond(payload => chat(reviewFor(payload)));
  const review = await f.listing.review({ ...f.reference, suggestionResultId: result.id });
  assert.throws(() => validateStoredAiResult({ ...review, listingNormalization: result.listingNormalization }));
  const noAuthority: any = structuredClone(result);
  noAuthority.output.candidates.find((candidate: any) => candidate.field === 'material').items[0].value = 'Plastic';
  Object.assign(noAuthority.listingNormalization.entries[0], { rawValue: ' Plastic ', value: 'Plastic' });
  assert.throws(() => validateAiResult(noAuthority), 'a genuine trim trace cannot authorize a false material');
  assert.throws(() => validateStoredAiResult(noAuthority));
});

test('old literal evidence versions preserve candidate whitespace, absent trace, context hash and stored JSON', async t => {
  const f = await fixture(t);
  for (const version of [undefined, 'listing-evidence/v1', 'listing-evidence/v2', 'listing-evidence/v3'] as const) {
    const result = structuredClone(await f.listing.suggest(f.reference));
    if (result.output.kind !== 'amazon-fields') throw Error('fixture output');
    result.output.candidates.find(candidate => candidate.field === 'item_name')!.items[0].value = ' Blue Silicone Coaster ';
    if (version === undefined) delete result.listingEvidenceContractVersion; else result.listingEvidenceContractVersion = version;
    const raw = JSON.stringify(result), output = JSON.stringify(result.output), context = JSON.stringify(result.listingContext), hash = result.sourceSha256;
    const db = openDatabase(f.directory);
    try {
      db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(raw, result.id);
      const read = f.ai.getResult(result.id)!;
      assert.equal(Object.hasOwn(read, 'listingNormalization'), false);
      assert.equal(JSON.stringify(read.output), output); assert.equal(JSON.stringify(read.listingContext), context); assert.equal(read.sourceSha256, hash);
      assert.equal(String(db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(result.id)!.record_json), raw);
    } finally { db.close(); }
  }
});

test('new normalization and adopted values survive restart and encrypted backup beside old literal records', async t => {
  const f = await fixture(t), records = new Map<string, string>();
  for (const version of [undefined, 'listing-evidence/v1', 'listing-evidence/v2', 'listing-evidence/v3'] as const) {
    const result = structuredClone(await f.listing.suggest(f.reference));
    if (result.output.kind !== 'amazon-fields') throw Error('fixture output');
    result.output.candidates.find(candidate => candidate.field === 'item_name')!.items[0].value = ' Blue Silicone Coaster ';
    if (version === undefined) delete result.listingEvidenceContractVersion; else result.listingEvidenceContractVersion = version;
    records.set(result.id, JSON.stringify(result));
    const db = openDatabase(f.directory); try { db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(records.get(result.id)!, result.id); } finally { db.close(); }
  }
  f.respond(payload => chat(payload.candidate ? reviewFor(payload) : formatted(payload)));
  const suggestion = await f.listing.suggest(f.reference), review = await f.listing.review({ ...f.reference, suggestionResultId: suggestion.id });
  const draft = await f.listing.adopt({ ...f.reference, suggestionResultId: suggestion.id, reviewResultId: review.id, fields: ['material'] });
  assert.deepEqual((draft.attributes.material as any[])[0].value, 'Silicone');
  assertListingHistory(draft, new Map(f.ai.listResults(f.product.id).map(result => [result.id, result])), new Map(f.ai.listCalls().map(call => [call.id, call])));
  const db = openDatabase(f.directory); try { for (const result of [suggestion, review]) records.set(result.id, String(db.prepare('SELECT record_json FROM ai_results WHERE id=?').get(result.id)!.record_json)); } finally { db.close(); }
  await f.ai.close(); let requests = 0;
  const restarted = new AiService(f.directory, f.store, f.hosting, mockStorage, { fetch: async () => { requests++; throw Error('Unexpected provider call'); } });
  try { for (const [id, raw] of records) assert.deepEqual(restarted.getResult(id), JSON.parse(raw)); assert.equal(requests, 0); } finally { await restarted.close(); }
  const file = join(f.directory, 'normalization.htcbackup'), restoredPath = join(f.directory, 'normalization-restored'), password = 'isolated normalization backup';
  await createWorkspaceBackup(f.directory, file, password);
  await commitWorkspaceRestore(restoredPath, await prepareWorkspaceRestore(restoredPath, file, password));
  const restored = openDatabase(restoredPath);
  try {
    for (const [id, raw] of records) {
      const actual = String(restored.prepare('SELECT record_json FROM ai_results WHERE id=?').get(id)!.record_json);
      assert.equal(actual, raw); assert.deepEqual(validateStoredAiResult(JSON.parse(actual)), JSON.parse(raw));
    }
    const actual = JSON.parse(String(restored.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(draft.id)!.record_json));
    assert.deepEqual(actual.draft.fieldAdoptions, draft.fieldAdoptions); assert.deepEqual(actual.draft.attributes, draft.attributes);
  } finally { restored.close(); }
});

test('partial repair persistence stores only retained candidate traces', async t => {
  const f = await fixture(t), context = buildListingContext(f.draft, f.product, 1);
  context.fields = context.fields.filter(field => ['color', 'material'].includes(field.name));
  context.repairRequest = { issues: [], currentValues: {} };
  f.respond(payload => { const output = candidateFor(payload); for (const candidate of output.candidates) candidate.items[0].value = candidate.field === 'material' ? ' Plastic ' : ' Blue '; return chat(output); });
  const result = await f.ai.listingFields(context, async () => {});
  if (result.output.kind !== 'amazon-fields') throw Error('fixture output');
  assert.deepEqual(result.output.candidates.map(candidate => candidate.field), ['color']);
  assert.deepEqual(result.listingNormalization!.entries.map(entry => entry.field), ['color']);
  assert.deepEqual(f.ai.getResult(result.id), result);
});

test('five bullet conversions retain their exact item indices across result persistence', async t => {
  const schema = { type: 'array', minItems: 5, maxItems: 5, items: { type: 'object', properties: { value: { type: 'string' }, marketplace_id: { type: 'string' } }, required: ['value'], additionalProperties: false } };
  const f = await fixture(t, { bullet_point: schema });
  const values = [' Blue silicone coaster ', ' Silicone coaster in blue ', ' A coaster made of silicone ', ' Blue color for the coaster ', ' Silicone material for the coaster '];
  f.respond(payload => { const output = candidateFor(payload), evidenceIds = payload.evidence.map((evidence: any) => evidence.id); output.missing = output.missing.filter((entry: any) => entry.field !== 'bullet_point'); output.candidates.push({ field: 'bullet_point', items: values.map(value => ({ value, evidenceIds, transformation: 'compose' })) }); return chat(output); });
  const result = await f.listing.suggest(f.reference);
  assert.deepEqual(result.listingNormalization!.entries.map(entry => [entry.field, entry.index, entry.rawValue, entry.value]), values.map((value, index) => ['bullet_point', index, value, value.trim()]));
  assert.deepEqual(f.ai.getResult(result.id), result);
  const bad = structuredClone(result); bad.listingNormalization!.entries[4].index = 0; assert.throws(() => validateStoredAiResult(bad));
});

test('normalization still cannot adopt a value that fails the complete schema', async t => {
  const schema = { type: 'array', items: { type: 'object', properties: { value: { type: 'string', maxLength: 4 }, marketplace_id: { type: 'string' } }, required: ['value'], additionalProperties: false } };
  const f = await fixture(t, { material: schema }); f.respond(payload => chat(formatted(payload)));
  const result = await f.listing.suggest(f.reference);
  assert.ok(result.listingNormalization);
  f.ai.saveFunctionSettings({ id: 'deepseek-review', model: 'deepseek-v4-pro', enabled: false });
  await assert.rejects(f.listing.adopt({ ...f.reference, suggestionResultId: result.id, reviewResultId: null, fields: ['material'] }), /候选字段不符合规则/);
  assert.equal(f.amazon.getDraft(f.draft.id).revision, f.draft.revision);
  assert.equal(f.amazon.getDraft(f.draft.id).fieldAdoptions?.length ?? 0, 0);
});
