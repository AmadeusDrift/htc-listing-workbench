import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/main/database.ts';
import type { AmazonDraft, AmazonTarget, ListingIssue } from '../src/shared/amazon-contracts.ts';

const implementation = await import('../src/main/followup/service.ts').catch(() => null);
const records = await import('../src/main/followup/records.ts').catch(() => null);
const minute = 60_000, initial = Date.parse('2026-10-07T00:00:00.000Z');
const offsets = [30 * minute, 60 * minute, 120 * minute, 360 * minute, 1_440 * minute];
const failure: ListingIssue = { code: 'INVALID_ATTRIBUTE', message: 'Please correct the product field', severity: 'ERROR', attributeNames: ['item_name'], category: 'field', source: 'amazon', autoFixable: false };
const platformReview: ListingIssue = { code: '100521', message: 'We are reviewing this listing to determine if any additional information is required. Please allow up to 48 hours for this process to complete. You will be notified here if your action is needed, otherwise the listing will be published.', severity: 'ERROR', attributeNames: [], category: 'field', source: 'amazon', autoFixable: false };

test('a main-only task boundary preserves unrelated legacy followups through construction, timers and manual actions', async t => {
  const f=fixture(t);f.service.schedule(f.draft.id);await f.service.close();f.at(2*86_400_000);
  const db=openDatabase(f.directory),before=db.prepare('SELECT * FROM listing_followups ORDER BY id').all();
  const managed=new implementation!.FollowupService(f.directory,f.amazon,{now:()=>initial+2*86_400_000,canManageDraft:()=>false} as any);
  try {
    assert.deepEqual(managed.list().map(row=>JSON.stringify(row)),before.map(row=>String(row.record_json)));
    managed.start();await managed.runDue();assert.equal(f.reads,0);
    assert.throws(()=>managed.reschedule(f.draft.id),/受控/);
    assert.throws(()=>managed.schedule(randomUUID()),/受控/);
    assert.deepEqual(db.prepare('SELECT * FROM listing_followups ORDER BY id').all(),before);
  } finally {await managed.close();db.close();}
});

function fixture(t: test.TestContext) {
  assert.ok(implementation?.FollowupService, 'persistent delayed follow-up service must exist');
  const parent = resolve('.test-data'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'followup-'));
  const db = openDatabase(directory);
  db.exec('CREATE TABLE IF NOT EXISTS listing_followups(id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL)'); db.close();
  let now = initial, generation = 1;
  const target: AmazonTarget = { id: randomUUID(), name: 'Offline target', mode: 'live', sellerId: 'FIXTURE_SELLER', marketplaceId: 'ATVPDKIKX0DER', marketplaceName: 'US', region: 'na', locale: 'en_US', configured: true, paused: false, credentialUpdatedAt: new Date(initial).toISOString(), lastError: null };
  let draft: AmazonDraft = { id: randomUUID(), productId: randomUUID(), productRevision: 1, variantId: randomUUID(), sku: 'FOLLOWUP-ONLY', targetId: target.id, targetName: target.name, sellerId: target.sellerId, marketplaceId: target.marketplaceId, mode: 'live', listingProgram: 'haul', revision: 4,
    schema: { targetId: target.id, productType: 'STORAGE_BAG', parentageLevel: 'NONE', requirements: 'LISTING', locale: 'en_US', key: 'fixture', mode: 'live', schema: {}, metaSchema: {}, checksum: 'fixture', version: 'v1', propertyGroups: {}, fetchedAt: new Date(initial).toISOString(), expiresAt: new Date(initial + 86_400_000).toISOString(), fromCache: false },
    attributes: { item_name: 'Fixture' }, state: 'SUBMITTED', localIssues: [], previewIssues: [], listingIssues: [], statuses: [], submissionId: 'accepted-fixture', requestId: 'fixture', previewedAt: null, submittedAt: new Date(initial).toISOString(), checkedAt: null, createdAt: new Date(initial).toISOString(), updatedAt: new Date(initial).toISOString(), events: [] };
  let reads = 0, outcome: 'pending' | 'ready' | 'error' | 'network' | 'review' = 'pending', observationAsin: string | null = null;
  let reviewIssues = [platformReview];
  let hold: Promise<void> | null = null, release = () => {}, readEntered = () => {};
  const timers: { callback: () => void; delay: number; cancelled: boolean }[] = [];
  const amazon = {
    getDraft(id: string) { assert.equal(id, draft.id); return structuredClone(draft); },
    executionTargetScope(id: string) { assert.equal(id, target.id); return { target: structuredClone(target), generation }; },
    async readListing(input: unknown) {
      const ref = input as { id: string; revision: number }; assert.deepEqual(ref, { id: draft.id, revision: draft.revision });
      reads++; readEntered(); if (hold) await hold;
      if (outcome === 'network') throw new Error('Network is unavailable');
      draft = { ...draft, state: outcome === 'ready' ? 'BUYABLE' : outcome === 'error' ? 'BLOCKED' : outcome === 'review' ? 'DISCOVERABLE' : 'PROCESSING', statuses: outcome === 'ready' ? ['BUYABLE'] : outcome === 'review' ? ['DISCOVERABLE'] : [], listingIssues: outcome === 'error' ? [failure] : outcome === 'review' ? reviewIssues : [], checkedAt: new Date(now).toISOString() };
      return structuredClone(draft);
    },
    getListingObservation() { return draft.checkedAt ? { draftId: draft.id, targetId: draft.targetId, sellerId: draft.sellerId, marketplaceId: draft.marketplaceId, sku: draft.sku, checkedAt: draft.checkedAt, requestId: draft.requestId, asin: observationAsin, fnsku: null, statuses: [...draft.statuses], issues: structuredClone(draft.listingIssues) } : null; },
  };
  const dependencies = { now: () => now,
    setTimeout(callback: () => void, delay: number) { const timer = { callback, delay, cancelled: false }; timers.push(timer); return timer; },
    clearTimeout(timer: unknown) { (timer as typeof timers[number]).cancelled = true; },
  };
  let service = new implementation.FollowupService(directory, amazon, dependencies);
  t.after(async () => { release(); await service.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, amazon, target, timers, get draft() { return draft; }, get reads() { return reads; }, get service() { return service; },
    at(offset: number) { now = initial + offset; }, outcome(value: typeof outcome) { outcome = value; }, asin(value: string | null) { observationAsin = value; },
    review(issues: ListingIssue[] = [platformReview]) { outcome = 'review'; reviewIssues = structuredClone(issues); },
    edit(patch: Partial<AmazonDraft>) { draft = { ...draft, ...patch }; }, rotate() { generation++; },
    holdRead() { hold = new Promise<void>(resolve => { release = resolve; }); return new Promise<void>(resolve => { readEntered = resolve; }); }, release() { release(); hold = null; },
    async reopen() { await service.close(); service = new implementation!.FollowupService(directory, amazon, dependencies); },
  };
}

test('accepted submission waits thirty minutes and scheduling is durable and idempotent', async t => {
  const f = fixture(t), scheduled = f.service.schedule(f.draft.id);
  assert.equal(scheduled.status, 'WAITING'); assert.equal(scheduled.nextDueAt, new Date(initial + offsets[0]).toISOString());
  assert.deepEqual(f.service.schedule(f.draft.id), scheduled);
  f.at(offsets[0] - 1); await f.service.runDue(); assert.equal(f.reads, 0);
  f.at(offsets[0]); await f.service.runDue();
  const pending = f.service.get(f.draft.id);
  assert.equal(f.reads, 1); assert.equal(pending.status, 'PROCESSING'); assert.equal(pending.attempts, 1);
  assert.equal(pending.nextDueAt, new Date(initial + offsets[1]).toISOString());
  assert.deepEqual(f.service.schedule(f.draft.id), pending);
  const summary = f.service.summary(); assert.equal(summary.processing, 1); assert.equal(summary.waiting, 0); assert.equal(summary.nextDueAt, pending.nextDueAt);
});

test('restart preserves the remaining delay and resumes readback without any submission API', async t => {
  const f = fixture(t); f.service.schedule(f.draft.id); f.at(offsets[0]); await f.service.runDue();
  const pending = f.service.get(f.draft.id); await f.reopen(); assert.deepEqual(f.service.list(), [pending]);
  f.at(offsets[1] - 1); await f.service.runDue(); assert.equal(f.reads, 1);
  f.outcome('ready'); f.at(offsets[1]); await f.service.runDue();
  assert.equal(f.reads, 2); assert.equal(f.service.get(f.draft.id).status, 'READY'); assert.equal(f.service.get(f.draft.id).nextDueAt, null);
});

test('ASIN from matching readback is explicit creation evidence, while an empty issue list alone is not', async t => {
  const f = fixture(t); f.service.schedule(f.draft.id); f.at(offsets[0]); await f.service.runDue();
  assert.equal(f.service.get(f.draft.id).status, 'PROCESSING');
  f.asin('B0ABC12345'); f.at(offsets[1]); await f.service.runDue();
  const ready = f.service.get(f.draft.id); assert.equal(ready.status, 'READY'); assert.equal(ready.asin, 'B0ABC12345'); assert.equal(ready.fnsku, null); assert.deepEqual(ready.statuses, []);
});

test('explicit listing errors require attention even if an ASIN exists', async t => {
  const f = fixture(t); f.asin('B0ABC12345'); f.outcome('error'); f.service.schedule(f.draft.id); f.at(offsets[0]); await f.service.runDue();
  const result = f.service.get(f.draft.id); assert.equal(result.status, 'NEEDS_ATTENTION'); assert.equal(result.reason, 'LISTING_ERRORS'); assert.equal(result.nextDueAt, null); assert.deepEqual(result.issues, [failure]);
});

test('Amazon 100521 stays platform processing despite DISCOVERABLE and an ASIN, retaining the original ERROR', async t => {
  const f = fixture(t); f.review(); f.asin('B0ABC12345'); f.service.schedule(f.draft.id); f.at(offsets[0]); await f.service.runDue();
  const result = f.service.get(f.draft.id);
  assert.equal(result.status, 'PROCESSING'); assert.equal(result.reason, 'PLATFORM_REVIEW');
  assert.equal(result.listingState, 'DISCOVERABLE'); assert.deepEqual(result.statuses, ['DISCOVERABLE']); assert.equal(result.asin, 'B0ABC12345');
  assert.deepEqual(result.issues, [platformReview]); assert.match(result.error!, /Amazon.*审核.*24/);
  assert.equal(result.nextDueAt, new Date(initial + offsets[1]).toISOString());
  await f.reopen(); assert.deepEqual(f.service.get(f.draft.id), result);
});

test('only explicit Amazon 100521 is deferred; mixed errors, lookalike codes and non-Amazon issues still block', async t => {
  for (const issues of [[platformReview, failure], [{ ...platformReview, code: '1005210' }], [{ ...platformReview, source: 'local' as const }], [{ ...platformReview, code: 'OTHER', message: platformReview.message }]]) {
    const f = fixture(t); f.review(issues); f.asin('B0ABC12345'); f.service.schedule(f.draft.id); f.at(offsets[0]); await f.service.runDue();
    const result = f.service.get(f.draft.id);
    assert.equal(result.status, 'NEEDS_ATTENTION'); assert.equal(result.reason, 'LISTING_ERRORS'); assert.equal(result.nextDueAt, null);
    assert.deepEqual(result.issues, issues);
  }
});

test('100521 expires at 24h and explicit requery keeps original clock', async t => {
 const f=fixture(t); f.review(); f.service.schedule(f.draft.id);
 for(const offset of offsets){f.at(offset);await f.service.runDue();}
 assert.equal(f.service.get(f.draft.id).reason,'EXPIRED');
 await f.reopen();f.at(25*60*minute);f.service.reschedule(f.draft.id);await f.service.runDue();
 assert.equal(f.service.get(f.draft.id).reason,'EXPIRED');
 assert.equal(f.service.get(f.draft.id).submittedAt,new Date(initial).toISOString());
 f.outcome('ready');f.service.reschedule(f.draft.id);await f.service.runDue();assert.equal(f.service.get(f.draft.id).status,'READY');
});

test('cleared platform review reaches ready only after a later fresh read with no blocking issue', async t => {
  const f = fixture(t); f.review(); f.service.schedule(f.draft.id); f.at(offsets[0]); await f.service.runDue();
  assert.equal(f.service.get(f.draft.id).status, 'PROCESSING');
  f.outcome('ready'); f.at(offsets[1]); await f.service.runDue();
  const result = f.service.get(f.draft.id);
  assert.equal(result.status, 'READY'); assert.equal(result.reason, null); assert.equal(result.nextDueAt, null); assert.deepEqual(result.issues, []);
});

test('requeries retain attempts without premature expiry', async t => {
 const f=fixture(t);f.service.schedule(f.draft.id);f.at(offsets[0]);
 for(let i=0;i<8;i++){f.service.reschedule(f.draft.id);await f.service.runDue();}
 assert.equal(f.service.get(f.draft.id).status,'PROCESSING');assert.equal(f.service.get(f.draft.id).attempts,8);
 await f.reopen();assert.equal(f.service.get(f.draft.id).status,'PROCESSING');
 f.at(offsets.at(-1)!);await f.service.runDue();assert.equal(f.service.get(f.draft.id).reason,'EXPIRED');
});

test('a slow review response beyond 24 hours expires without scheduling another query', async t => {
  const f = fixture(t); f.review(); f.service.schedule(f.draft.id); f.at(offsets[0]); const entered = f.holdRead();
  const running = f.service.runDue(); await entered; f.at(25 * 60 * minute); f.release(); await running;
  const result = f.service.get(f.draft.id);
  assert.equal(result.status, 'NEEDS_ATTENTION'); assert.equal(result.reason, 'EXPIRED'); assert.equal(result.nextDueAt, null);
  assert.deepEqual(result.issues, [platformReview]); await f.service.runDue(); assert.equal(f.reads, 1);
});

for (const outcome of ['pending', 'network'] as const) test(`${outcome} readback uses finite persisted retry slots and expires as attention`, async t => {
  const f = fixture(t); f.outcome(outcome); f.service.schedule(f.draft.id);
  for (const offset of offsets) { f.at(offset); await f.service.runDue(); }
  const result = f.service.get(f.draft.id);
  assert.equal(f.reads, 5); assert.equal(result.status, 'NEEDS_ATTENTION'); assert.equal(result.reason, 'EXPIRED'); assert.equal(result.attempts, 5); assert.equal(result.nextDueAt, null);
  f.at(7 * 86_400_000); await f.service.runDue(); await f.reopen(); await f.service.runDue(); assert.equal(f.reads, 5);
});

test('late startup skips missed retry slots instead of bursting requests', async t => {
  const f = fixture(t); f.service.schedule(f.draft.id); f.at(3 * 60 * minute); await f.reopen(); await f.service.runDue();
  assert.equal(f.reads, 1); assert.equal(f.service.get(f.draft.id).nextDueAt, new Date(initial + offsets[3]).toISOString());
});

test('unknown write is retained for attention and never automatically read or replayed', async t => {
  const f = fixture(t); f.edit({ state: 'UNKNOWN', submittedAt: null, submissionId: null });
  const result = f.service.schedule(f.draft.id); assert.equal(result.status, 'NEEDS_ATTENTION'); assert.equal(result.reason, 'UNKNOWN_WRITE');
  f.at(86_400_000); await f.service.runDue(); await f.reopen(); await f.service.runDue(); assert.equal(f.reads, 0);
  assert.throws(() => f.service.reschedule(f.draft.id), /未知|核对/);
});

for (const field of ['sellerId', 'marketplaceId', 'mode', 'paused', 'configured', 'generation', 'sku', 'revision', 'attributes'] as const) test(`${field} change prevents a due query`, async t => {
  const f = fixture(t); f.service.schedule(f.draft.id);
  if (field === 'generation') f.rotate();
  else if (field === 'sku') f.edit({ sku: 'CHANGED-SKU' });
  else if (field === 'revision') f.edit({ revision: f.draft.revision + 1 });
  else if (field === 'attributes') f.edit({ attributes: { item_name: 'Changed' } });
  else if (field === 'paused') f.target.paused = true;
  else if (field === 'configured') f.target.configured = false;
  else if (field === 'mode') f.target.mode = 'demo';
  else f.target[field] = 'CHANGED';
  f.at(offsets[0]); await f.service.runDue();
  assert.equal(f.reads, 0); assert.equal(f.service.get(f.draft.id).status, 'NEEDS_ATTENTION'); assert.equal(f.service.get(f.draft.id).nextDueAt, null);
});

test('explicit reschedule can refresh credentials only for the same original identity', async t => {
  const f = fixture(t); f.service.schedule(f.draft.id); f.rotate(); f.at(offsets[0]); await f.service.runDue();
  assert.equal(f.service.schedule(f.draft.id).status, 'NEEDS_ATTENTION');
  const retried = f.service.reschedule(f.draft.id); assert.equal(retried.status, 'WAITING'); assert.equal(retried.targetGeneration, 2);
  f.outcome('ready'); await f.service.runDue(); assert.equal(f.service.get(f.draft.id).status, 'READY');
  f.target.sellerId = 'OTHER_SELLER'; assert.throws(() => f.service.reschedule(f.draft.id), /身份|店铺|变化/);
});

test('scope change while a request is in flight cannot produce a ready result', async t => {
  const f = fixture(t); f.outcome('ready'); f.service.schedule(f.draft.id); f.at(offsets[0]); const entered = f.holdRead();
  const pending = f.service.runDue(); await entered; f.rotate(); f.release(); await pending;
  assert.equal(f.service.get(f.draft.id).status, 'NEEDS_ATTENTION'); assert.equal(f.service.get(f.draft.id).reason, 'TARGET_CHANGED');
});

test('start arms the persisted delay and close cancels timers and waits for the active read', async t => {
  const f = fixture(t); f.service.schedule(f.draft.id); f.service.start(); assert.equal(f.timers.filter(timer => !timer.cancelled).at(-1)!.delay, offsets[0]);
  f.at(offsets[0]); const entered = f.holdRead(); const pending = f.service.runDue(); await entered;
  let closed = false; const closing = f.service.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false); assert.ok(f.timers.every(timer => timer.cancelled));
  f.release(); await pending; await closing; assert.equal(closed, true);
  for (const timer of f.timers) timer.callback(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.reads, 1);
  await assert.rejects(f.service.runDue(), /停止|关闭/);
});

test('simultaneous due checks share the in-flight request and checkpoint before await', async t => {
  const f = fixture(t); f.service.schedule(f.draft.id); f.at(offsets[0]); const entered = f.holdRead();
  const a = f.service.runDue(); await entered; const b = f.service.runDue();
  const db = openDatabase(f.directory); const saved = JSON.parse(String(db.prepare('SELECT record_json FROM listing_followups').get()!.record_json)); db.close();
  assert.equal(saved.attempts, 1); assert.equal(saved.nextDueAt, new Date(initial + offsets[1]).toISOString());
  f.release(); await Promise.all([a, b]); assert.equal(f.reads, 1);
});

test('follow-up records reject hidden fields, invalid nested issues and inconsistent ready evidence', t => {
  const f = fixture(t); const valid = f.service.schedule(f.draft.id); assert.ok(records?.validateFollowupRecord);
  assert.deepEqual(records.validateFollowupRecord(valid), valid);
  for (const invalid of [
    { ...valid, password: 'MUST_NOT_EXPORT' }, { ...valid, attempts: -1 }, { ...valid, nextDueAt: 'not-a-date' },
    { ...valid, issues: [{ ...failure, authorization: 'MUST_NOT_EXPORT' }] },
    { ...valid, status: 'READY', nextDueAt: null }, { ...valid, targetGeneration: 1.5 },
  ]) assert.throws(() => records.validateFollowupRecord(invalid));
});

test('a rescheduled read cannot reuse ASIN evidence from an older successful check', async t => {
  const f = fixture(t); f.asin('B0ABC12345'); f.service.schedule(f.draft.id); f.at(offsets[0]); await f.service.runDue();
  assert.equal(f.service.get(f.draft.id).status, 'READY');
  f.service.reschedule(f.draft.id); f.asin(null); f.amazon.getListingObservation = () => null;
  await f.service.runDue(); const pending = f.service.get(f.draft.id);
  assert.equal(pending.status, 'PROCESSING'); assert.equal(pending.asin, null); assert.equal(pending.fnsku, null);
});

test('an unavailable matching observation cannot promote otherwise buyable draft state to ready', async t => {
  const f = fixture(t); f.outcome('ready'); f.amazon.getListingObservation = () => null;
  f.service.schedule(f.draft.id); f.at(offsets[0]); await f.service.runDue();
  assert.equal(f.service.get(f.draft.id).status, 'PROCESSING');
});

test('a slow pending read skips retry slots that passed before the response arrived', async t => {
  const f = fixture(t); f.service.schedule(f.draft.id); f.at(offsets[0]); const entered = f.holdRead();
  const pending = f.service.runDue(); await entered; f.at(3 * 60 * minute); f.release(); await pending;
  assert.equal(f.service.get(f.draft.id).nextDueAt, new Date(initial + offsets[3]).toISOString());
  await f.service.runDue(); assert.equal(f.reads, 1);
});

test('close prevents later due drafts from starting after the active read settles', async t => {
  const f = fixture(t), second = { ...f.draft, id: randomUUID(), sku: 'SECOND-SKU' }, originalGet = f.amazon.getDraft;
  f.amazon.getDraft = id => id === second.id ? structuredClone(second) : originalGet(id);
  f.service.schedule(f.draft.id); f.service.schedule(second.id); f.at(offsets[0]); const entered = f.holdRead();
  const running = f.service.runDue(); await entered; const closing = f.service.close(); f.release(); await running; await closing;
  assert.equal(f.reads, 1);
  const db = openDatabase(f.directory); const saved = JSON.parse(String(db.prepare('SELECT record_json FROM listing_followups WHERE id=?').get(second.id)!.record_json)); db.close();
  assert.equal(saved.status, 'WAITING'); assert.equal(saved.attempts, 0);
});

test('an interrupted final checkpoint recovers to attention without repeating the request', async t => {
  const f = fixture(t), record = f.service.schedule(f.draft.id);
  const db = openDatabase(f.directory);
  db.prepare('UPDATE listing_followups SET record_json=? WHERE id=?').run(JSON.stringify({ ...record, status: 'PROCESSING', attempts: 5, lastAttemptAt: new Date(initial + offsets[4]).toISOString(), nextDueAt: null }), record.id); db.close();
  f.at(offsets[4]); await f.reopen(); assert.equal(f.service.get(f.draft.id).status, 'NEEDS_ATTENTION');
  await f.service.runDue(); assert.equal(f.reads, 0);
});

test('automatic timer performs a due check and leaves the next retry scheduled', async t => {
  const f = fixture(t); f.service.schedule(f.draft.id); f.service.start(); f.at(offsets[0]);
  f.timers.at(-1)!.callback(); await f.service.runDue();
  assert.equal(f.reads, 1); assert.equal(f.service.get(f.draft.id).status, 'PROCESSING'); assert.equal(f.timers.at(-1)!.delay, offsets[1] - offsets[0]);
});

test('unsubmitted and demonstration drafts cannot enter the real follow-up queue', t => {
  const f = fixture(t); f.edit({ mode: 'demo' }); assert.throws(() => f.service.schedule(f.draft.id), /演示/);
  f.edit({ mode: 'live', submittedAt: null, state: 'DRAFT' }); assert.throws(() => f.service.schedule(f.draft.id), /已提交/);
  assert.equal(f.service.list().length, 0);
});

for (const change of ['close', 'generation', 'pause'] as const) test(`${change} while awaiting a transport slot prevents a later listing request`, async t => {
  const f = fixture(t); let enter = () => {}, release = () => {}, requests = 0;
  if (change === 'pause') assert.equal(typeof f.service.pause, 'function', 'follow-up service must support maintenance pause');
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  f.amazon.readListing = async (_input: unknown, beforeSend?: () => void) => { enter(); await held; beforeSend?.(); requests++; return f.draft; };
  f.service.schedule(f.draft.id); f.at(offsets[0]); const running = f.service.runDue(); await entered;
  let closing: Promise<void> | undefined;
  if (change === 'close') closing = f.service.close(); else if (change === 'pause') f.service.pause(); else f.rotate();
  release(); await running; await closing; assert.equal(requests, 0);
  if (change === 'generation') assert.equal(f.service.get(f.draft.id).reason, 'TARGET_CHANGED');
});

test('maintenance pause cancels timers and prevents manual due runs until resume', async t => {
  const f = fixture(t); assert.equal(typeof f.service.pause, 'function', 'follow-up service must support maintenance pause');
  f.service.schedule(f.draft.id); f.service.start(); assert.equal(f.service.busy, false);
  f.service.pause(); assert.ok(f.timers.every(timer => timer.cancelled)); f.at(offsets[0]);
  await assert.rejects(f.service.runDue(), /暂停/); assert.equal(f.reads, 0);
  for (const timer of f.timers) timer.callback(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.reads, 0);
  f.service.resume(); assert.equal(f.timers.at(-1)!.delay, 0); await f.service.runDue(); assert.equal(f.reads, 1);
});

test('maintenance pause retains busy until the active read settles and does not start another due SKU', async t => {
  const f = fixture(t); assert.equal(typeof f.service.pause, 'function', 'follow-up service must support maintenance pause');
  const second = { ...f.draft, id: randomUUID(), sku: 'SECOND-SKU' }, originalGet = f.amazon.getDraft;
  f.amazon.getDraft = id => id === second.id ? structuredClone(second) : originalGet(id);
  f.service.schedule(f.draft.id); f.service.schedule(second.id); f.at(offsets[0]); const entered = f.holdRead();
  const running = f.service.runDue(); await entered; assert.equal(f.service.busy, true); f.service.pause(); assert.equal(f.service.busy, true);
  f.release(); await running; assert.equal(f.service.busy, false); assert.equal(f.reads, 1);
  assert.equal(f.service.get(second.id).status, 'WAITING'); assert.equal(f.service.get(second.id).attempts, 0);
});

for(const legacy of ['extended','premature'] as const)test(`legacy ${legacy} schedule migrates to original 24h deadline`,async t=>{
 const f=fixture(t),record=f.service.schedule(f.draft.id);const db=openDatabase(f.directory);
 db.prepare('UPDATE listing_followups SET record_json=? WHERE id=?').run(JSON.stringify({...record,status:legacy==='extended'?'PROCESSING':'NEEDS_ATTENTION',attempts:5,reason:legacy==='extended'?'PLATFORM_REVIEW':'EXPIRED',issues:[platformReview],nextDueAt:legacy==='extended'?new Date(initial+48*60*minute).toISOString():null}),record.id);db.close();
 f.at(6*60*minute);await f.reopen();assert.equal(f.service.get(f.draft.id).status,'PROCESSING');assert.equal(f.service.get(f.draft.id).nextDueAt,new Date(initial+24*60*minute).toISOString());
 f.at(24*60*minute);await f.reopen();assert.equal(f.service.get(f.draft.id).reason,'EXPIRED');
});
test('known creation without buyability never expires merely from elapsed time',async t=>{
 const f=fixture(t);f.asin('B0ABC12345');f.service.schedule(f.draft.id);f.at(offsets[0]);await f.service.runDue();
 f.at(48*60*minute);await f.reopen();assert.equal(f.service.get(f.draft.id).status,'READY');assert.deepEqual(f.service.get(f.draft.id).statuses,[]);
});

for(const outcome of ['pending','ready','network'] as const)test(`explicit expired requery survives restart once: ${outcome}`,async t=>{
 const f=fixture(t);f.service.schedule(f.draft.id);f.at(24*60*minute);await f.service.runDue();
 assert.equal(f.service.get(f.draft.id).reason,'EXPIRED');const reads=f.reads;
 f.at(25*60*minute);f.service.reschedule(f.draft.id);await f.reopen();f.outcome(outcome);await f.service.runDue();
 assert.equal(f.reads,reads+1);assert.equal(f.service.get(f.draft.id).submittedAt,new Date(initial).toISOString());
 assert.equal(f.service.get(f.draft.id).status,outcome==='ready'?'READY':'NEEDS_ATTENTION');
 await f.reopen();f.at(26*60*minute);await f.service.runDue();assert.equal(f.reads,reads+1);
});
