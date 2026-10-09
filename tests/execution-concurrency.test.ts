import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/main/store.ts';
import { AmazonService } from '../src/main/amazon/service.ts';
import { ExecutionService } from '../src/main/execution/service.ts';
import { stepNames, validateExecutionTask } from '../src/main/execution/records.ts';
import type { ExecutionTask, StepName } from '../src/shared/execution-contracts.ts';
import type { AmazonDraft, JsonObject } from '../src/shared/amazon-contracts.ts';

const safeStorage = { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release = () => {}; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
type Event = { draftId: string; step: StepName; phase: 'start' | 'finish'; batchId?: string };

async function fixture(t: test.TestContext, count = 7) {
  const parent = resolve('.test-data'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'execution-concurrency-'));
  const store = new WorkspaceStore(directory);
  const amazon = new AmazonService(directory, id => store.getProduct(id), safeStorage, { fetch: async () => { throw Error('Unexpected network'); } });
  const drafts: AmazonDraft[] = [], assets: string[] = [], events: Event[] = [];
  const uploaded = new Map<string, { id: string; assetId: string; profileId: string; generation: number; sha256: string; publicUrl: string; status: string }>();
  const target = amazon.enableDemo();
  for (let i = 0; i < count; i++) {
    let product = store.createProduct(); const variantId = product.variants[0].id, assetId = randomUUID();
    const sha256 = createHash('sha256').update(`fixture-image-${i}`).digest('hex');
    product = store.addAssets({ productId: product.id, revision: product.revision }, [{ id: assetId, fileName: `main-${i}.png`, mimeType: 'image/png', width: 1000, height: 1000,
      byteSize: 10, originalPath: `assets/${assetId}.png`, previewPath: `assets/${assetId}.preview.png`, sha256 }]);
    product = store.updateAsset({ productId: product.id, revision: product.revision, assetId, role: 'main', variantIds: [variantId] });
    let draft = await amazon.createDraft({ targetId: target.id, productId: product.id, variantId, productType: 'HTC_DEMO_STORAGE_BAG', parentageLevel: 'NONE', requirements: 'LISTING', locale: 'en_US' });
    draft = amazon.saveDraft({ id: draft.id, revision: draft.revision, attributes: { ...draft.attributes,
      brand: [{ value: 'Verified Brand', marketplace_id: target.marketplaceId }], color: [{ value: `Color ${i}`, marketplace_id: target.marketplaceId }],
      purchasable_offer: [{ marketplace_id: target.marketplaceId, currency: 'USD', audience: 'ALL', our_price: [{ schedule: [{ value_with_tax: 12.5 }] }] }] } });
    drafts.push(draft); assets.push(assetId);
    uploaded.set(assetId, { id: randomUUID(), assetId, profileId: 'alpha', generation: 1, sha256, publicUrl: `https://images.example.com/${assetId}.png`, status: 'AVAILABLE' });
  }
  const event = (draftId: string, step: StepName, phase: Event['phase'], batchId?: string) => events.push({ draftId, step, phase, ...(batchId ? { batchId } : {}) });
  const saveDraft = amazon.saveDraft.bind(amazon);
  amazon.saveDraft = input => { const id = (input as { id: string }).id; event(id, 'images', 'start'); try { return saveDraft(input); } finally { event(id, 'images', 'finish'); } };
  for (const [method, step] of [['validateDraft', 'validate'], ['previewDraft', 'preview'], ['readListing', 'readback']] as const) {
    const original = amazon[method].bind(amazon);
    amazon[method] = async input => { const id = (input as { id: string }).id; event(id, step, 'start'); try { return await original(input); } finally { event(id, step, 'finish'); } };
  }
  const submitDraft = amazon.submitDraft.bind(amazon);
  amazon.submitDraft = async (input, confirmed, taskGuard) => {
    const id = (input as { id: string }).id; event(id, 'submit', 'start');
    try { return await submitDraft(input, confirmed, taskGuard); } finally { event(id, 'submit', 'finish'); }
  };
  const pending = new Map<string, ReturnType<typeof gate>>(), failures = new Set<string>();
  const signals: AbortSignal[] = []; let automatic = false, peakUploads = 0;
  const hosting = {
    getProfile: () => ({ id: 'alpha', name: 'Alpha', host: 'ftp.example.com', port: 2121, secure: false, remoteRoot: '/', publicBaseUrl: 'https://images.example.com/', enabled: true, configured: true, generation: 1 }),
    upload: async (input: { assetId: string; batchId: string }, signal?: AbortSignal) => {
      const index = assets.indexOf(input.assetId); assert.ok(index >= 0);
      const held = gate(); pending.set(input.assetId, held); if (signal) signals.push(signal);
      peakUploads = Math.max(peakUploads, pending.size); event(drafts[index].id, 'upload', 'start', input.batchId);
      if (automatic) held.release();
      try { await held.promise; if (failures.has(input.assetId)) throw Error('Controlled upload failure'); return structuredClone(uploaded.get(input.assetId)!); }
      finally { pending.delete(input.assetId); event(drafts[index].id, 'upload', 'finish', input.batchId); }
    },
    verify: async (id: string) => { const result = [...uploaded.values()].find(value => value.id === id); assert.ok(result); return structuredClone(result); },
  };
  const releaseAll = () => { automatic = true; for (const held of pending.values()) held.release(); };
  let service = new ExecutionService(directory, store, amazon, hosting);
  t.after(async () => { releaseAll(); await service.close(); amazon.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, amazon, drafts, assets, events, pending, failures, signals, get peakUploads() { return peakUploads; }, get service() { return service; },
    release(assetId: string) { const held = pending.get(assetId); assert.ok(held, 'upload must have entered its barrier'); held.release(); }, releaseAll,
    create(concurrency?: number, selected = drafts) { return service.create({ draftIds: selected.map(d => d.id), profileId: 'alpha', ...(concurrency === undefined ? {} : { concurrency }) }); },
    start(id: string) { return service.startAuthorized(service.prepareStart(id)); },
    async reopen() { await service.close(); service = new ExecutionService(directory, store, amazon, hosting); },
    getRows() { const db = new DatabaseSync(join(directory, 'red.sqlite')); try { return db.prepare('SELECT record_json FROM execution_tasks ORDER BY rowid').all().map(row => JSON.parse(String(row.record_json)) as ExecutionTask); } finally { db.close(); } },
  };
}

function peakSkus(events: Event[]): number {
  const active = new Set<string>(); let peak = 0;
  for (const event of events) {
    if (event.step === 'upload' && event.phase === 'start') active.add(event.draftId);
    if (event.step === 'readback' && event.phase === 'finish') active.delete(event.draftId);
    peak = Math.max(peak, active.size);
  }
  assert.equal(active.size, 0); return peak;
}

test('task concurrency defaults to one, persists explicitly, and only accepts numeric 1, 3 or 5', async t => {
  const f = await fixture(t, 4);
  for (const concurrency of [undefined, null, '1', '3', '5', 0, 2, 4, 6, -1, 1.5, NaN, Infinity, true, {}, []]) {
    assert.throws(() => f.service.create({ draftIds: [f.drafts[0].id], profileId: 'alpha', concurrency }), /并发|1.*3.*5/);
  }
  assert.throws(() => f.service.create({ draftIds: [f.drafts[0].id], profileId: 'alpha', concurrency: 3, extra: true }), /字段/);
  const normal = f.create(undefined, [f.drafts[0]]); assert.equal(normal.concurrency, 1);
  for (const [index, concurrency] of [1, 3, 5].entries()) assert.equal(f.create(concurrency, [f.drafts[index + 1]]).concurrency, concurrency);
  assert.deepEqual(f.getRows().map(task => task.concurrency), [1, 1, 3, 5]);
  await f.reopen(); assert.deepEqual(f.service.list().reverse().map(task => task.concurrency), [1, 1, 3, 5]);
});

test('legacy task normalization is strict and does not mutate its input', async t => {
  const f = await fixture(t, 1), task = f.create(); const legacy = { ...task } as Partial<ExecutionTask>; delete legacy.concurrency;
  assert.deepEqual(validateExecutionTask(legacy), { ...legacy, concurrency: 1 }); assert.equal('concurrency' in legacy, false);
  assert.throws(() => validateExecutionTask({ ...legacy, secret: 'unexpected' }), /字段/);
  const incomplete = { ...legacy }; delete incomplete.status; assert.throws(() => validateExecutionTask(incomplete), /不完整/);
  assert.throws(() => validateExecutionTask({ ...legacy, items: [{ ...task.items[0], secret: 'unexpected' }] }), /字段/);
  for (const concurrency of [undefined, null, '1', '3', 2, 10, NaN]) assert.throws(() => validateExecutionTask({ ...legacy, concurrency }), /并发|格式/);
  const db = new DatabaseSync(join(f.directory, 'red.sqlite'));
  db.prepare('UPDATE execution_tasks SET record_json=? WHERE id=?').run(JSON.stringify({ ...legacy, status: 'QUEUED' }), task.id); db.close();
  await f.reopen(); assert.equal(f.service.get(task.id).concurrency, 1); assert.equal(f.service.get(task.id).status, 'PAUSED');
  assert.equal(f.getRows()[0].concurrency, 1); assert.equal(f.events.length, 0);
});

test('native start approval fingerprints the complete task including concurrency', async t => {
  const f = await fixture(t, 1), task = f.create(3), approved = f.service.prepareStart(task.id);
  assert.equal(approved.concurrency, 3); approved.concurrency = 5;
  assert.throws(() => f.service.startAuthorized(approved), /确认期间任务已变化/); assert.equal(f.events.length, 0);
  assert.equal(f.getRows()[0].concurrency, 3);
});

test('concurrent tasks retain duplicate draft and same-listing SKU queue protection', async t => {
  const f = await fixture(t, 1), draft = f.drafts[0];
  const duplicate = await f.amazon.createDraft({ targetId: draft.targetId, productId: draft.productId, variantId: draft.variantId,
    productType: draft.schema.productType, parentageLevel: draft.schema.parentageLevel, requirements: draft.schema.requirements, locale: draft.schema.locale });
  assert.throws(() => f.create(5, [draft, draft]), /重复/);
  assert.throws(() => f.create(5, [draft, duplicate]), /同一店铺 SKU/);
  f.create(3, [draft]); assert.throws(() => f.create(5, [draft]), /未结束任务/);
  assert.throws(() => f.create(1, [duplicate]), /同一店铺 SKU/); assert.equal(f.events.length, 0);
});

for (const concurrency of [1, 3, 5]) test(`${concurrency} workers reach and obey the SKU limit while seven distinct SKUs keep every step in order`, async t => {
  const f = await fixture(t), task = f.create(concurrency); f.start(task.id); await turn();
  assert.equal(f.pending.size, concurrency, 'all configured workers must reach independent upload barriers');
  assert.equal(f.service.get(task.id).items.filter(item => item.status === 'RUNNING').length, concurrency);
  f.release(f.assets[0]); await turn();
  assert.equal(f.service.get(task.id).items[0].status, 'DONE'); assert.equal(f.pending.size, concurrency);
  assert.equal(f.service.get(task.id).items[concurrency].steps[0].status, 'RUNNING');
  f.releaseAll(); await f.service.waitForIdle(); const done = f.service.get(task.id);
  assert.equal(done.status, 'COMPLETED'); assert.equal(f.peakUploads, concurrency); assert.equal(peakSkus(f.events), concurrency);
  assert.deepEqual(f.getRows()[0], done);
  for (const [index, item] of done.items.entries()) {
    assert.deepEqual(f.events.filter(event => event.draftId === item.draftId).map(event => `${event.step}:${event.phase}`), stepNames.flatMap(step => [`${step}:start`, `${step}:finish`]));
    assert.ok(item.steps.every(step => step.status === 'DONE' && step.attempts === 1));
    const draft = f.amazon.getDraft(item.draftId);
    assert.equal((draft.attributes.main_product_image_locator as JsonObject[])[0].media_location, `https://images.example.com/${f.assets[index]}.png`);
    assert.equal((draft.attributes.color as JsonObject[])[0].value, `Color ${index}`);
  }
  assert.equal(f.amazon.listCalls().filter(call => call.operation === 'putListingsItem').length, 7);
});

test('a task with fewer SKUs than workers starts only its actual SKU count', async t => {
  const f = await fixture(t, 2), task = f.create(5); f.start(task.id); await turn();
  assert.equal(f.pending.size, 2); f.releaseAll(); await f.service.waitForIdle();
  assert.equal(f.service.get(task.id).status, 'COMPLETED'); assert.equal(peakSkus(f.events), 2);
});

test('queued batches wait for every SKU in the active batch and share a global limit of five', async t => {
  const f = await fixture(t, 14), first = f.create(5, f.drafts.slice(0, 7)), second = f.create(5, f.drafts.slice(7));
  f.start(first.id); f.start(second.id); await turn(); assert.equal(f.pending.size, 5);
  assert.equal(f.service.get(second.id).status, 'QUEUED'); assert.ok(f.events.every(event => event.batchId === first.id));
  f.release(f.assets[0]); await turn(); assert.equal(f.service.get(first.id).items[0].status, 'DONE');
  assert.equal(f.service.get(second.id).status, 'QUEUED'); assert.ok(!f.events.some(event => event.batchId === second.id));
  f.releaseAll(); await f.service.waitForIdle(); assert.equal(f.service.get(first.id).status, 'COMPLETED'); assert.equal(f.service.get(second.id).status, 'COMPLETED');
  const secondStart = f.events.findIndex(event => event.batchId === second.id);
  assert.ok(f.drafts.slice(0, 7).every(draft => f.events.findIndex(event => event.draftId === draft.id && event.step === 'readback' && event.phase === 'finish') < secondStart));
  assert.equal(peakSkus(f.events), 5); assert.equal(f.peakUploads, 5);
});

test('one failed SKU does not stop its peers or finalize the batch before they settle', async t => {
  const f = await fixture(t), task = f.create(3); f.failures.add(f.assets[0]); f.start(task.id); await turn();
  assert.equal(f.pending.size, 3); f.release(f.assets[0]); await turn();
  const running = f.service.get(task.id); assert.equal(running.status, 'RUNNING'); assert.equal(running.items[0].status, 'FAILED'); assert.equal(f.pending.size, 3);
  f.releaseAll(); await f.service.waitForIdle(); const done = f.service.get(task.id);
  assert.equal(done.status, 'NEEDS_ATTENTION'); assert.equal(done.items[0].steps[0].status, 'FAILED');
  assert.ok(done.items.slice(1).every(item => item.status === 'DONE')); assert.equal(f.amazon.listCalls().filter(call => call.operation === 'putListingsItem').length, 6);
  assert.deepEqual(f.getRows()[0], done);
});

test('a failed initial SKU checkpoint is isolated and the other workers keep processing', async t => {
  const f = await fixture(t), task = f.create(3), db = new DatabaseSync(join(f.directory, 'red.sqlite'));
  db.exec(`CREATE TRIGGER fail_first_sku_checkpoint BEFORE UPDATE ON execution_tasks
    WHEN json_extract(NEW.record_json, '$.items[0].status') = 'RUNNING'
      AND json_extract(NEW.record_json, '$.items[0].steps[0].status') = 'PENDING'
      AND json_extract(NEW.record_json, '$.items[1].status') = 'PENDING'
    BEGIN SELECT RAISE(ABORT, 'controlled checkpoint failure'); END`); db.close();
  f.start(task.id); await turn(); assert.equal(f.service.get(task.id).items[0].status, 'FAILED');
  assert.equal(f.pending.size, 3); f.releaseAll(); await f.service.waitForIdle();
  const done = f.service.get(task.id); assert.equal(done.status, 'NEEDS_ATTENTION');
  assert.ok(done.items.slice(1).every(item => item.status === 'DONE')); assert.deepEqual(f.getRows()[0], done);
});

test('an unexpected rejected worker cannot release the active batch or close its peers database early', async t => {
  const f = await fixture(t, 9), first = f.create(3, f.drafts.slice(0, 7)), second = f.create(5, f.drafts.slice(7));
  const db = new DatabaseSync(join(f.directory, 'red.sqlite'));
  // Reject both the initial checkpoint and its error checkpoint. The next worker
  // changes item 1, allowing all later checkpoints to persist normally.
  db.exec(`CREATE TRIGGER fail_worker_checkpoints BEFORE UPDATE ON execution_tasks
    WHEN json_array_length(NEW.record_json, '$.items') = 7
      AND json_extract(NEW.record_json, '$.items[0].status') != 'PENDING'
      AND json_extract(NEW.record_json, '$.items[1].status') = 'PENDING'
    BEGIN SELECT RAISE(ABORT, 'controlled worker failure'); END`); db.close();
  f.start(first.id); f.start(second.id); await turn();
  assert.equal(f.pending.size, 2); assert.equal(f.service.busy, true); assert.equal(f.service.get(second.id).status, 'QUEUED');
  let closed = false; const closing = f.service.close().then(() => { closed = true; });
  f.release(f.assets[1]); await turn(); assert.equal(closed, false); assert.equal(f.service.busy, true); assert.equal(f.pending.size, 1);
  assert.equal(f.getRows()[0].items[1].steps[0].status, 'DONE');
  f.releaseAll(); await closing; const rows = f.getRows();
  assert.equal(rows[0].status, 'PAUSED'); assert.equal(rows[0].items[2].steps[0].status, 'DONE');
  assert.equal(rows[1].status, 'PAUSED'); assert.ok(rows[1].items.every(item => item.steps.every(step => step.attempts === 0)));
  assert.equal(f.events.filter(event => event.phase === 'start').length, 2);
});

for (const action of ['pause', 'cancel'] as const) test(`${action} stops new SKUs and steps while waiting for all three in-flight uploads`, async t => {
  const f = await fixture(t), task = f.create(3); f.start(task.id); await turn(); assert.equal(f.pending.size, 3);
  f.service[action](task.id); let idle = false; const waiting = f.service.waitForIdle().then(() => { idle = true; });
  assert.equal(f.signals.every(signal => signal.aborted), action === 'cancel');
  f.release(f.assets[0]); await turn(); assert.equal(idle, false); assert.equal(f.service.busy, true); assert.equal(f.pending.size, 2);
  assert.equal(f.events.filter(event => event.phase === 'start').length, 3);
  f.releaseAll(); await waiting; const stopped = f.service.get(task.id);
  assert.equal(stopped.status, action === 'pause' ? 'PAUSED' : 'CANCELLED'); assert.ok(stopped.items.slice(0, 3).every(item => item.steps[0].status === 'DONE'));
  assert.ok(stopped.items.every(item => item.steps.slice(1).every(step => step.attempts === 0)));
  assert.ok(stopped.items.slice(3).every(item => item.steps[0].attempts === 0)); assert.deepEqual(f.getRows()[0], stopped);
});

test('close waits for all five in-flight operations before closing the database and leaves queued work paused', async t => {
  const f = await fixture(t, 9), first = f.create(5, f.drafts.slice(0, 7)), second = f.create(3, f.drafts.slice(7));
  f.start(first.id); f.start(second.id); await turn(); assert.equal(f.pending.size, 5);
  let closed = false; const closing = f.service.close().then(() => { closed = true; });
  assert.ok(f.signals.every(signal => signal.aborted));
  f.release(f.assets[0]); await turn(); assert.equal(closed, false); assert.equal(f.pending.size, 4);
  assert.equal(f.getRows()[0].items[0].steps[0].status, 'DONE');
  f.releaseAll(); await closing; const persisted = f.getRows();
  assert.ok(persisted.every(task => task.status === 'PAUSED')); assert.ok(persisted[0].items.slice(0, 5).every(item => item.steps[0].status === 'DONE'));
  assert.ok(persisted[1].items.every(item => item.steps.every(step => step.attempts === 0))); assert.equal(f.events.filter(event => event.phase === 'start').length, 5);
  await f.reopen(); await f.service.waitForIdle(); assert.equal(f.events.filter(event => event.phase === 'start').length, 5);
});

test('restart after partial completion resumes only unfinished steps and never repeats finished writes', async t => {
  const f = await fixture(t), task = f.create(3); f.start(task.id); await turn(); f.release(f.assets[0]); await turn();
  assert.equal(f.service.get(task.id).items[0].status, 'DONE'); assert.equal(f.pending.size, 3);
  f.service.pause(task.id); f.releaseAll(); await f.service.waitForIdle(); const paused = f.service.get(task.id);
  assert.equal(paused.items.filter(item => item.steps[0].status === 'DONE').length, 4);
  const finishedEvents = f.events.filter(event => event.draftId === f.drafts[0].id); await f.reopen();
  assert.equal(f.service.get(task.id).status, 'PAUSED'); assert.equal(f.service.get(task.id).concurrency, 3);
  f.start(task.id); await f.service.waitForIdle(); const done = f.service.get(task.id); assert.equal(done.status, 'COMPLETED');
  assert.deepEqual(f.events.filter(event => event.draftId === f.drafts[0].id), finishedEvents);
  assert.ok(done.items.every(item => item.steps.every(step => step.attempts === 1)));
  assert.equal(f.events.filter(event => event.step === 'upload' && event.phase === 'start').length, 7);
  assert.equal(f.amazon.listCalls().filter(call => call.operation === 'putListingsItem').length, 7);
  assert.deepEqual(f.getRows()[0], done);
});

test('pause during three submit preflights blocks every write until an authorized resume', async t => {
  const f = await fixture(t), task = f.create(3), getSchema = f.amazon.getSchema.bind(f.amazon);
  const held: ReturnType<typeof gate>[] = []; let holding = true;
  f.amazon.getSchema = async input => {
    if (holding && (input as { forceRefresh?: boolean }).forceRefresh) { const pending = gate(); held.push(pending); await pending.promise; }
    return getSchema(input);
  };
  try {
    f.releaseAll(); f.start(task.id); await turn(); assert.equal(held.length, 3);
    assert.ok(f.service.get(task.id).items.slice(0, 3).every(item => item.steps[4].status === 'RUNNING'));
    f.service.pause(task.id); held[0].release(); await turn(); assert.equal(f.service.busy, true);
    assert.equal(f.amazon.listCalls().filter(call => call.operation === 'putListingsItem').length, 0);
    holding = false; for (const pending of held) pending.release(); await f.service.waitForIdle();
    const paused = f.service.get(task.id); assert.equal(paused.status, 'PAUSED');
    assert.ok(paused.items.every(item => !item.submitStarted)); assert.ok(paused.items.slice(3).every(item => item.steps.every(step => step.attempts === 0)));
    f.start(task.id); await f.service.waitForIdle(); assert.equal(f.service.get(task.id).status, 'COMPLETED');
    assert.equal(f.amazon.listCalls().filter(call => call.operation === 'putListingsItem').length, 7);
  } finally { holding = false; for (const pending of held) pending.release(); }
});

test('an unknown submission is isolated and only read back after a concurrent batch is restarted', async t => {
  const f = await fixture(t), task = f.create(3), submit = f.amazon.submitDraft.bind(f.amazon), unknownId = f.drafts[0].id; let uncertainWrites = 0;
  f.amazon.submitDraft = async (input, confirmed, guard) => {
    if ((input as { id: string }).id !== unknownId) return submit(input, confirmed, guard);
    uncertainWrites++; const db = new DatabaseSync(join(f.directory, 'red.sqlite'));
    try {
      const row = db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(unknownId)!;
      const record = JSON.parse(String(row.record_json)); record.unresolvedWrite = true; record.draft.state = 'UNKNOWN'; record.preview = null;
      db.prepare("UPDATE listing_drafts SET record_json=?,state='UNKNOWN' WHERE id=?").run(JSON.stringify(record), unknownId);
    } finally { db.close(); }
    return f.amazon.getDraft(unknownId);
  };
  f.releaseAll(); f.start(task.id); await f.service.waitForIdle();
  const first = f.service.get(task.id); assert.equal(first.status, 'NEEDS_ATTENTION'); assert.equal(first.items[0].listingState, 'UNKNOWN');
  assert.ok(first.items.slice(1).every(item => item.status === 'DONE')); const priorEvents = f.events.filter(event => event.draftId !== unknownId);
  await f.reopen(); f.start(task.id); await f.service.waitForIdle(); const retried = f.service.get(task.id);
  assert.equal(uncertainWrites, 1); assert.equal(retried.status, 'NEEDS_ATTENTION'); assert.equal(retried.items[0].steps[5].attempts, 2);
  assert.ok(retried.items[0].steps.slice(0, 5).every(step => step.attempts === 1));
  assert.deepEqual(f.events.filter(event => event.draftId !== unknownId), priorEvents);
  assert.equal(f.amazon.listCalls().filter(call => call.operation === 'putListingsItem').length, 6); assert.deepEqual(f.getRows()[0], retried);
});
