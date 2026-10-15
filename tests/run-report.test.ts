import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { openDatabase } from '../src/main/database.ts';
import { appendRunEvidence } from '../src/main/diagnostics/run-evidence.ts';
import { saveProviderReceipt } from '../src/main/ai/receipts.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { installDiagnosticsIpc } from '../src/main/diagnostics-ipc.ts';
import { readRunReportBuildContext } from '../src/main/diagnostics/service.ts';

const implementation = await import('../src/main/diagnostics/run-report.ts').catch(() => null);
const at = '2026-10-15T01:00:00.000Z', bait = 'sk-PRIVATE_DIAGNOSTIC_BAIT';
async function fixture(t: test.TestContext, count = 2) {
  await mkdir(resolve('.test-data'), { recursive: true }); const root = await mkdtemp(resolve('.test-data/run-report-')), directory = join(root, 'data');
  const store = new WorkspaceStore(directory), product = store.createProduct(), db = openDatabase(directory), taskId = randomUUID(), draftId = randomUUID();
  const item = { key: product.id+':'+product.variants[0].id, productId: product.id, variantId: product.variants[0].id, sku: 'HTC-合成-18', draftId, stage: 'IMAGES', status: 'FAILED', executionTaskIds: [] };
  const task = { id: taskId, revision: 7, status: 'PAUSED', items: [item], secret: bait };
  db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(taskId, JSON.stringify(task));
  const calls: string[] = [];
  for (let i = 0; i < count; i++) {
    const callId = randomUUID(); calls.push(callId);
    db.prepare('INSERT INTO ai_calls VALUES(?,?)').run(callId, JSON.stringify({ id: callId, productId: product.id, status: i ? 'FAILED' : 'SUCCEEDED', errorCode: i ? 'TIMEOUT' : null, startedAt: at, finishedAt: at, presentationContext: { draftId }, headers: { Authorization: bait }, url: 'https://private.test/'+bait, rawResponse: bait }));
    appendRunEvidence(db, product.id, { version: 1, at, event: 'DISPATCH_ATTEMPTED', stage: 'fields', taskId, itemKey: item.key, sku: item.sku, draftId, callId, certainty: 'SENT_UNKNOWN' });
  }
  const receipt = await saveProviderReceipt(db, directory, calls[0], { gateway: 'openrouter', endpoint: '/api/v1/chat/completions', model: 'fixture', status: 200, requestId: 'fixture-1', receivedAt: at, costUsd: null, body: { choices: [], secret: bait } }, undefined);
  const resultId = randomUUID(); db.prepare('INSERT INTO ai_results VALUES(?,?)').run(resultId, JSON.stringify({ id: resultId, callId: calls[0], createdAt: at, listingContext: { draftId }, output: { secret: bait } }));
  appendRunEvidence(db, product.id, { version: 1, at, event: 'RECEIPT_SAVED', stage: 'fields', taskId, itemKey: item.key, callId: calls[0], receiptId: receipt.id });
  const context = { appVersion: '2.5.0', sourceCommit: 'a'.repeat(40), sourceDigest: 'b'.repeat(64), buildDigest: 'c'.repeat(64) };
  t.after(async () => { db.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, directory, store, product, db, taskId, draftId, item, calls, context };
}
test('current-connection report separates received valid but unadopted output from sent unknown', async t => {
  const f = await fixture(t);
  assert.equal(typeof implementation?.RunReportReader, 'function', 'current connection report is missing');
  const reader = new implementation!.RunReportReader(f.db, f.context), report = reader.query({ taskId: f.taskId, sku: f.item.sku });
  assert.equal(report.provenance.consistentSnapshot, true); assert.equal(report.provenance.connection, 'CURRENT_PROCESS');
  assert.equal(report.counts.totalCalls, 2); assert.equal(report.counts.savedReceipts, 1); assert.equal(report.counts.validResults, 1);
  assert.equal(report.counts.adoptedResults, 0); assert.equal(report.counts.submittedSkus, 0); assert.equal(report.counts.buyableSkus, 0);
  assert.equal(report.calls.find((c: any) => c.callId === f.calls[0])!.certainty, 'RECEIVED_VALID');
  const unknown = report.calls.find((c: any) => c.callId === f.calls[1])!; assert.equal(unknown.certainty, 'SENT_UNKNOWN'); assert.equal(unknown.nextAction, 'VERIFY_ORIGINAL_REQUEST');
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_DIAGNOSTIC_BAIT|https:|Authorization|rawResponse|red.sqlite|choices/);
  await mkdir(resolve('artifacts/stabilization'), { recursive: true });
  await writeFile(resolve('artifacts/stabilization/s01-run-report-example.json'), JSON.stringify(report, null, 2)+'\n');
});
test('current error summary uses saved selected-task rows without rechecking or writing', async t => {
  const f = await fixture(t), anotherProduct = randomUUID(), unrelatedTask = randomUUID();
  const row = { ...f.item, error: 'color 缺少有效依据', outcome: { kind: 'NEEDS_INPUT', code: 'FIELD_REQUIRED' } };
  const items = [row, { ...row, key: f.product.id+':'+randomUUID(), sku: 'HTC-合成-19' }, { ...row, productId: anotherProduct, key: anotherProduct+':'+randomUUID(), sku: 'HTC-合成-20' }, { ...row, status: 'PENDING', sku: 'HTC-合成-21' }, { ...row, status: 'SCREENED', sku: 'HTC-合成-22' }];
  f.db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify({ id:f.taskId, revision:8, items }), f.taskId);
  f.db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(unrelatedTask, JSON.stringify({ id:unrelatedTask, items:[row] }));
  const before = f.db.prepare('SELECT total_changes() n').get()!.n;
  f.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?)').run(randomUUID(), f.product.id, 'operation.failed', 'synthetic diagnostic', JSON.stringify({version:1,taskId:f.taskId,stage:'fields',code:'NETWORK_ERROR',validationField:'color',validationPath:'$.output.candidates',networkDiagnostic:{cause:'CONNECTION_RESET',stage:'body',httpStatus:200,receivedBytes:32}}),at);
  const changesAfterFixture = f.db.prepare('SELECT total_changes() n').get()!.n;
  const reader = new implementation!.RunReportReader(f.db), report = reader.query({ taskId:f.taskId });
  assert.equal(report.currentFailures.affectedProducts, 2); assert.equal(report.currentFailures.failedSalesItems, 3);
  assert.equal(report.currentFailures.groups[0].productCount, 2);
  assert.equal(reader.export({ taskId:f.taskId, sku:row.sku }).currentFailures.affectedProducts, 1);
  assert.deepEqual(report.errors[0].networkDiagnostic,{cause:'CONNECTION_RESET',stage:'body',httpStatus:200,receivedBytes:32});
  assert.equal(report.errors[0].validationField,'color'); assert.equal(report.errors[0].validationPath,'$.output.candidates');
  assert.equal(f.db.prepare('SELECT total_changes() n').get()!.n, changesAfterFixture); assert.equal(changesAfterFixture,Number(before)+1);
});
test('pagination counts the whole scope, binds filters and rejects changed snapshots', async t => {
  const f = await fixture(t, 121);
  assert.ok(implementation?.RunReportReader, 'run report pagination missing');
  const reader = new implementation!.RunReportReader(f.db, f.context), first = reader.query({ taskId: f.taskId, pageSize: 20 });
  assert.equal(first.calls.length, 20); assert.equal(first.counts.totalCalls, 121); assert.equal(first.page.total, 121); assert.ok(first.page.nextCursor);
  assert.throws(() => reader.query({ taskId: randomUUID(), cursor: first.page.nextCursor }), /RUN_REPORT_CURSOR/);
  let page = first, seen = first.calls.length;
  while (page.page.nextCursor) { page = reader.query({ taskId: f.taskId, pageSize: 20, cursor: page.page.nextCursor }); seen += page.calls.length; }
  assert.equal(seen, 121); assert.equal(reader.export({ taskId: f.taskId }).calls.length, 121);
  f.db.prepare('UPDATE automatic_listing_tasks SET record_json=json_set(record_json,\'$.revision\',8) WHERE id=?').run(f.taskId);
  assert.throws(() => reader.query({ taskId: f.taskId, cursor: first.page.nextCursor }), /RUN_REPORT_CURSOR/);
});
test('100 current-connection reads leave task, journals, calls, audit and usage bytes unchanged', async t => {
  const f = await fixture(t);
  assert.equal(typeof (f.store as any).getRunDiagnostics, 'function', 'store current connection report missing');
  const tables = ['automatic_listing_tasks','listing_completion_operations','ai_calls','ai_results','ai_usage_ledger','audit_events'];
  const snapshot = () => JSON.stringify(tables.map(table => f.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()));
  const before = snapshot(); let requests = 0; t.mock.method(globalThis, 'fetch', async () => { requests++; throw Error('No network allowed'); });
  for (let i = 0; i < 100; i++) (f.store as any).getRunDiagnostics({ taskId: f.taskId });
  assert.equal(snapshot(), before); assert.equal(requests, 0);
});
test('legacy calls with no exact task or draft ownership are never assigned by matching time', async t => {
  const f = await fixture(t); assert.ok(implementation?.RunReportReader);
  const id = randomUUID(); f.db.prepare('INSERT INTO ai_calls VALUES(?,?)').run(id, JSON.stringify({ id, productId: f.product.id, startedAt: at, status: 'FAILED', errorCode: 'CANCELLED' }));
  const report = new implementation!.RunReportReader(f.db, f.context).query({ taskId: f.taskId });
  assert.equal(report.counts.totalCalls, 2); assert.equal(report.coverage.unassignedProductCalls, 1); assert.ok(report.coverage.missing.includes('LEGACY_TASK_CALL_LINK'));
});
test('stored adoption, generated candidate, platform exchanges and buyability retain distinct denominators', async t => {
  const f = await fixture(t); assert.ok(implementation?.RunReportReader);
  const resultId = f.db.prepare('SELECT id FROM ai_results').get()!.id, generationId = randomUUID(), candidateId = randomUUID();
  const draft = { id: f.draftId, sku: f.item.sku, mode: 'live', submittedAt: at, submissionId: 'synthetic-submission', checkedAt: at, statuses: ['BUYABLE'], fieldAdoptions: [{ suggestionResultId: resultId, reviewResultId: null }] };
  f.db.prepare("INSERT INTO listing_drafts(id,product_id,target_id,request_json,schema_checksum,validation_json,state,created_at,record_json) VALUES(?,?,NULL,'{}','','[]','SUBMITTED',?,?)").run(f.draftId, f.product.id, at, JSON.stringify({ draft }));
  for (const operation of ['preview','submit','readback']) { const exchangeId = randomUUID(); f.db.prepare('INSERT INTO amazon_exchanges VALUES(?,?,?,?)').run(exchangeId, f.draftId, at, JSON.stringify({ id: exchangeId, operation, at, status: 200, requestId: randomUUID() })); }
  f.db.prepare('INSERT INTO ai_image_requests VALUES(?,?)').run(generationId, JSON.stringify({ id: generationId, createdAt: at, productId: f.product.id }));
  const workflowId = randomUUID(); f.db.prepare('INSERT INTO image_workflow_runs VALUES(?,?)').run(workflowId, JSON.stringify({ id: workflowId, draftId: f.draftId, slots: [{ index: 1, approvedAssetId: randomUUID(), attempts: [{ requestId: generationId, candidateId, state: 'PASSED' }] }] }));
  const report = new implementation!.RunReportReader(f.db, f.context).query({ taskId: f.taskId });
  assert.deepEqual(report.counts, { totalCalls: 3, savedReceipts: 1, validResults: 2, adoptedResults: 2, submittedSkus: 1, buyableSkus: 1, demoSubmittedSkus: 0, previewRequests: 1, submissionRequests: 1, readbackRequests: 1, evidenceEvents: 3 });
  assert.equal(report.calls.find(c => c.callId === generationId)!.certainty, 'RECEIVED_VALID');
});

test('a locally derived result shares its paid call without counting the original as adopted', async t => {
  const f = await fixture(t), recoveredId = randomUUID();
  f.db.prepare('INSERT INTO ai_results VALUES(?,?)').run(recoveredId, JSON.stringify({ id: recoveredId, callId: f.calls[0] }));
  const draft = { id: f.draftId, sku: f.item.sku, mode: 'live', fieldAdoptions: [{ suggestionResultId: recoveredId, reviewResultId: null }] };
  f.db.prepare("INSERT INTO listing_drafts(id,product_id,target_id,request_json,schema_checksum,validation_json,state,created_at,record_json) VALUES(?,?,NULL,'{}','','[]','DRAFT',?,?)").run(f.draftId, f.product.id, at, JSON.stringify({ draft }));
  appendRunEvidence(f.db, f.product.id, { version: 1, at, event: 'RESULT_ADOPTED', stage: 'fields.adoption', taskId: f.taskId, itemKey: f.item.key, callId: f.calls[0], draftId: f.draftId });
  const report = new implementation!.RunReportReader(f.db).query({ taskId: f.taskId });
  assert.equal(report.counts.totalCalls, 2); assert.equal(report.counts.validResults, 2);
  assert.equal(report.counts.adoptedResults, 1, 'call-level adoption must not adopt every derived result');
});
test('completion journal provides exact old call identity without assigning unrelated same-product requests', async t => {
  const f = await fixture(t); assert.ok(implementation?.RunReportReader);
  const callId = randomUUID(), operationId = randomUUID();
  f.db.prepare('INSERT INTO ai_calls VALUES(?,?)').run(callId, JSON.stringify({ id: callId, productId: f.product.id, startedAt: at, status: 'FAILED', errorCode: 'NETWORK_ERROR' }));
  f.db.prepare('INSERT INTO listing_completion_operations VALUES(?,?)').run(operationId, JSON.stringify({ id: operationId, draftId: f.draftId, rounds: [{ candidate: { id: callId, sent: true } }] }));
  const report = new implementation!.RunReportReader(f.db, f.context).query({ taskId: f.taskId }), call = report.calls.find(c => c.callId === callId)!;
  assert.equal(report.counts.totalCalls, 3); assert.equal(call.operationId, operationId); assert.equal(call.association, 'DRAFT_REFERENCE'); assert.equal(call.certainty, 'SENT_UNKNOWN');
  assert.ok(!call.missing.includes('LEGACY_OPERATION_ID'), 'the journal preserved the operation ID');
});
test('old encrypted backup retains original safe event IDs without restoring arbitrary audit JSON', async t => {
  const f = await fixture(t), backup = join(f.root, 'before.htcbackup');
  // A separate valid backup scope: audit history can reference an old task/call
  // without recreating its business records. The report-only fixture above is minimal.
  for (const table of ['automatic_listing_tasks','ai_calls','ai_results','ai_provider_receipts']) f.db.exec('DELETE FROM '+table);
  await createWorkspaceBackup(f.directory, backup, 'isolated evidence restore');
  const original = { version: 1 as const, at, event: 'STAGE_BLOCKED' as const, stage: 'fields', taskId: f.taskId, itemKey: f.item.key, callId: f.calls[1], certainty: 'SENT_UNKNOWN' as const, errorCode: 'TIMEOUT' };
  appendRunEvidence(f.db, f.product.id, original);
  const event = f.db.prepare("SELECT id,detail_json FROM audit_events WHERE action='run.evidence' ORDER BY rowid DESC LIMIT 1").get()!;
  f.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?)').run(randomUUID(), f.product.id, 'operation.failed', bait, JSON.stringify({ secret: bait }), at);
  const prepared = await prepareWorkspaceRestore(f.directory, backup, 'isolated evidence restore');
  f.db.close(); f.store.close(); (f.db as any).close = () => {}; f.store.close = () => {};
  await commitWorkspaceRestore(f.directory, prepared);
  const restored = openDatabase(f.directory);
  try {
    assert.equal(restored.prepare('SELECT detail_json FROM audit_events WHERE id=?').get(event.id)?.detail_json, event.detail_json, 'backup discarded exact evidence');
    assert.equal(restored.prepare("SELECT COUNT(*) n FROM audit_events WHERE summary=?").get(bait)!.n, 0);
    assert.equal(restored.prepare('SELECT COUNT(*) n FROM automatic_listing_tasks').get()!.n, 0, 'audit retention must not recreate a task');
    assert.equal(restored.prepare('SELECT COUNT(*) n FROM ai_calls').get()!.n, 0, 'audit retention must not recreate a paid call');
  } finally { restored.close(); }
  const again = await prepareWorkspaceRestore(f.directory, backup, 'isolated evidence restore');
  await commitWorkspaceRestore(f.directory, again);
  const repeated = openDatabase(f.directory);
  try { assert.equal(repeated.prepare('SELECT COUNT(*) n FROM audit_events WHERE id=?').get(event.id)!.n, 1, 'stable event ID is retained once'); }
  finally { repeated.close(); }
});
test('run diagnostic IPC uses current store and exports the entire scope through native destination only', async t => {
  const f = await fixture(t), handlers = new Map<string, any>(), destination = join(f.root, 'report.json');
  installDiagnosticsIpc(f.directory, (channel, _count, run) => handlers.set(channel, run), { context: () => ({ appVersion: '2.5.0', runtime: { nodeMajor: 24, electronMajor: 44 }, services: { aiBusy: false, executionBusy: false, imageWritesBusy: false } }), selectDestination: async () => ({ canceled: false, filePath: destination }), runReport: { query: (q: unknown) => (f.store as any).getRunDiagnostics(q), export: (q: unknown) => (f.store as any).exportRunDiagnostics(q) } } as any);
  assert.ok(handlers.has('red:diagnostics:run-query'), 'run report IPC missing');
  const report = await handlers.get('red:diagnostics:run-query')({ taskId: f.taskId }); assert.equal(report.counts.totalCalls, 2);
  assert.deepEqual(await handlers.get('red:diagnostics:run-export')({ taskId: f.taskId }), { cancelled: false });
  const exported = JSON.parse(await readFile(destination, 'utf8')); assert.equal(exported.page.complete, true); assert.equal(exported.calls.length, 2); assert.doesNotMatch(JSON.stringify(exported), new RegExp(bait));
});

test('packaged build provenance comes from the matching package manifest and never a parent Git HEAD', async t => {
  const f = await fixture(t), packageRoot = join(f.root, 'package'), appPath = join(packageRoot, 'resources', 'app');
  await mkdir(appPath, { recursive: true });
  assert.deepEqual(readRunReportBuildContext('2.5.0', appPath), { appVersion: '2.5.0' });
  const manifest = { schema: 'htc-package/v1', source: { commit: 'd'.repeat(40), sourceDigest: 'e'.repeat(64) }, build: { schema: 'htc-build/v1', sourceCommit: 'd'.repeat(40) } };
  await writeFile(join(packageRoot, '版本与摘要.json'), JSON.stringify(manifest));
  const context = readRunReportBuildContext('2.5.0', appPath);
  assert.equal(context.sourceCommit, manifest.source.commit); assert.equal(context.sourceDigest, manifest.source.sourceDigest); assert.match(context.buildDigest!, /^[a-f0-9]{64}$/);
  manifest.build.sourceCommit = 'f'.repeat(40); await writeFile(join(packageRoot, '版本与摘要.json'), JSON.stringify(manifest));
  assert.equal(readRunReportBuildContext('2.5.0', appPath).buildDigest, undefined);
});


