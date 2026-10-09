import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openDatabase, SCHEMA_VERSION } from '../src/main/database.ts';
import { validateAiResult } from '../src/main/ai/validation.ts';

const baselineOnly = process.argv.includes('--baseline-only');
const rows = 20000, productCount = 100, rounds = 9, pageSize = 50;
mkdirSync(resolve('.test-data'), { recursive: true });
mkdirSync(resolve('artifacts'), { recursive: true });
const directory = mkdtempSync(resolve('.test-data/record-query-benchmark-'));
const artifact = resolve('artifacts/record-query-benchmark.json');
const db = openDatabase(directory);
const products = Array.from({ length: productCount }, () => randomUUID()), productId = products[0];
const inserted = [];
try {
  const insert = db.prepare('INSERT INTO ai_results(id,record_json) VALUES(?,?)');
  db.exec('BEGIN');
  for (let n = 0; n < rows; n++) {
    const value = validateAiResult({ id: randomUUID(), callId: randomUUID(), providerId: 'deepseek', productId: products[n % productCount], productRevision: 1,
      variantId: randomUUID(), assetId: null, assetSha256: null, sourceResultIds: [], model: 'deepseek-flash', createdAt: '2026-09-30T00:00:00.000Z', reviewState: 'unreviewed',
      output: { kind: 'text', title: `Synthetic product ${n}`, bullets: ['Synthetic material detail'], description: 'Synthetic benchmark description. '.repeat(20), attributes: [] } });
    insert.run(value.id, JSON.stringify(value)); if (value.productId === productId) inserted.push(value);
  }
  db.exec('COMMIT');
  const legacy = () => db.prepare('SELECT id,record_json FROM ai_results ORDER BY rowid').all().map(row => {
    const value = validateAiResult(JSON.parse(row.record_json)); assert.equal(value.id, row.id); return value;
  }).filter(row => row.productId === productId);
  function measure(operation) {
    operation(); const samplesMs = [];
    for (let n = 0; n < rounds; n++) { const start = performance.now(); const value = operation(); samplesMs.push(performance.now() - start); assert.deepEqual(value, inserted); }
    return { samplesMs, medianMs: [...samplesMs].sort((a, b) => a - b)[Math.floor(rounds / 2)] };
  }
  const base = { recordedAt: new Date().toISOString(), node: process.version, schemaVersion: SCHEMA_VERSION, dataset: { synthetic: true, rows, productCount, matchingRows: inserted.length, pageSize, rounds }, legacyFullParseFilter: measure(legacy) };
  if (baselineOnly) {
    writeFileSync(artifact, JSON.stringify({ baselineBeforeImplementation: base }, null, 2) + '\n');
  } else {
    const { RecordReader } = await import('../src/main/record-query.ts');
    const reader = new RecordReader(db);
    const paginated = () => { let cursor; const result = []; do { const page = reader.query('ai_results', { productId, pageSize, ...(cursor ? { cursor } : {}) }, validateAiResult); result.push(...page.items); cursor = page.nextCursor; } while (cursor); return result; };
    const sqlPages = measure(paginated), firstPageSamplesMs = [];
    for (let n = 0; n < rounds; n++) { const start = performance.now(), page = reader.query('ai_results', { productId, pageSize }, validateAiResult); firstPageSamplesMs.push(performance.now() - start); assert.deepEqual(page.items, inserted.slice(0, pageSize)); }
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT rowid,id,record_json FROM ai_results WHERE json_extract(record_json,'$.productId')=? AND rowid>? AND rowid<=? ORDER BY rowid LIMIT ?").all(productId, 0, rows, pageSize + 1);
    assert.ok(plan.some(row => String(row.detail).includes('record_ai_results_product')));
    const previous = JSON.parse(readFileSync(artifact, 'utf8'));
    writeFileSync(artifact, JSON.stringify({ ...previous, comparison: { ...base, sqlAllPages: sqlPages, sqlFirstPage: { samplesMs: firstPageSamplesMs, medianMs: [...firstPageSamplesMs].sort((a, b) => a - b)[Math.floor(rounds / 2)] }, explainQueryPlan: plan, correctness: { fullRecordsEqual: true, matchedRows: inserted.length, uniqueIds: new Set(paginated().map(row => row.id)).size }, timingIsInformational: true } }, null, 2) + '\n');
  }
  console.log(JSON.stringify({ artifact, mode: baselineOnly ? 'baseline' : 'comparison', rows, matchingRows: inserted.length, medianLegacyMs: base.legacyFullParseFilter.medianMs }));
} finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
