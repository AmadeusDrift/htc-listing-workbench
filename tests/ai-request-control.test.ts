import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/main/database.ts';
import { fixture, holdFetch, isCode, json } from './fixtures/ai-control.ts';

for (const provider of ['aliyun-ocr', 'aidge-segmentation', 'deepseek', 'deepseek-review'] as const) test(`${provider}: simultaneous equal callers share one HTTP, call and result even with concurrency one`, async t => {
  const f = await fixture(t, { maxConcurrency: 1 }); f.enable(provider);
  let invoke: (signal?: AbortSignal) => Promise<unknown>;
  if (provider === 'aliyun-ocr') invoke = signal => f.service.recognize(f.imageInput, signal);
  else if (provider === 'aidge-segmentation') { const hosted = await f.upload(); invoke = signal => f.service.segment({ ...f.imageInput, hostedAssetId: hosted.id }, signal); }
  else if (provider === 'deepseek') invoke = signal => f.service.suggest(f.textInput, signal);
  else { f.enable('deepseek'); const suggestion = await f.service.suggest(f.textInput); invoke = signal => f.service.review({ productId: f.product.id, productRevision: f.product.revision, suggestionResultId: suggestion.id }, signal); }
  const before = f.requests.length, first = invoke(), second = invoke();
  const results = await Promise.all([first, second]); assert.deepEqual(results[0], results[1]);
  assert.equal(f.requests.length - before, 1); assert.equal(f.service.listCalls().filter(c => c.providerId === provider).length, 1);
  await invoke(); assert.equal(f.requests.length - before, 2);
});

test('one waiter cancellation leaves the shared request alive; final waiter cancellation aborts it without late persistence', async t => {
  const held = holdFetch(), f = await fixture(t, { fetch: held.fetch }); f.enable('deepseek');
  const a = new AbortController(), b = new AbortController(), first = f.service.suggest(f.textInput, a.signal), second = f.service.suggest(f.textInput, b.signal);
  const firstRejected = assert.rejects(first, isCode('CANCELLED')); await held.started; a.abort(); await firstRejected;
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].options?.signal?.aborted, false);
  held.release(); const result = await second; assert.equal(f.service.listResults(f.product.id)[0].id, result.id);
  const last = holdFetch(); f.respond(last.fetch); const cancel = new AbortController(), pending = f.service.suggest(f.textInput, cancel.signal), rejected = assert.rejects(pending, isCode('CANCELLED'));
  await last.started; cancel.abort(); await rejected; await new Promise(resolve => setImmediate(resolve)); last.release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests[1].options?.signal?.aborted, true); assert.equal(f.service.listCalls().length, 2); assert.equal(f.service.listCalls()[1].status, 'FAILED'); assert.equal(f.service.listResults(f.product.id).length, 1);
});

test('failed shared requests are evicted so an explicit retry sends a new attempt', async t => {
  const f = await fixture(t, { fetch: async () => json({ error: 'failure' }, 500) }); f.enable('deepseek');
  const results = await Promise.allSettled([f.service.suggest(f.textInput), f.service.suggest(f.textInput)]); assert.ok(results.every(r => r.status === 'rejected')); assert.equal(f.requests.length, 1);
  await assert.rejects(f.service.suggest(f.textInput), isCode('PROVIDER_ERROR')); assert.equal(f.requests.length, 2);
});

test('changing source content under the same IDs never joins the in-flight request', async t => {
  const held = holdFetch(), f = await fixture(t, { fetch: held.fetch }); f.enable('deepseek');
  const first = f.service.suggest(f.textInput), rejected = assert.rejects(first, isCode('SOURCE_CHANGED')); await held.started;
  const db = openDatabase(f.directory); db.prepare('UPDATE facts SET value=? WHERE id=?').run('Linen', f.product.facts[0].id); db.close();
  const second = f.service.suggest(f.textInput); held.release(); await rejected; await second;
  assert.equal(f.requests.length, 2); assert.equal(f.service.listCalls().length, 2);
});

test('model changes and shutdown cancel all shared waiters without unhandled late replies', async t => {
  const held = holdFetch(), f = await fixture(t, { fetch: held.fetch }); f.enable('deepseek');
  const results = Promise.allSettled([f.service.suggest(f.textInput), f.service.suggest(f.textInput)]); await held.started;
  f.enable('deepseek', 'deepseek-v4-pro'); assert.ok((await results).every(r => r.status === 'rejected' && isCode('CONFIG_CHANGED')(r.reason)));
  const next = Promise.allSettled([f.service.suggest(f.textInput), f.service.suggest(f.textInput)]); await new Promise(resolve => setImmediate(resolve)); await f.service.close();
  assert.ok((await next).every(r => r.status === 'rejected' && isCode('CANCELLED')(r.reason))); held.release(); assert.equal(f.requests.length, 2);
});

test('a cancelled final waiter can immediately start a fresh operation while the old transport ignores abort', async t => {
  const held = holdFetch(), f = await fixture(t, { fetch: held.fetch, maxConcurrency: 1 }); f.enable('deepseek');
  const controller = new AbortController(), first = f.service.suggest(f.textInput, controller.signal), cancelled = assert.rejects(first, isCode('CANCELLED'));
  await held.started; controller.abort(); await cancelled;
  const next = f.service.suggest(f.textInput); held.release(); await next;
  assert.equal(f.requests.length, 2); assert.equal(f.service.listResults(f.product.id).length, 1);
});

test('different result IDs and changed OCR content never share a request even for the same SKU', async t => {
  const f = await fixture(t); f.enable('aliyun-ocr'); f.enable('deepseek'); const ocr = await f.service.recognize(f.imageInput);
  const db = openDatabase(f.directory), other = { ...ocr, id: randomUUID() }; db.prepare('INSERT INTO ai_results VALUES(?,?)').run(other.id, JSON.stringify(other));
  const held = holdFetch(); f.respond(held.fetch);
  const first = f.service.suggest({ ...f.textInput, ocrResultIds: [ocr.id] }), second = f.service.suggest({ ...f.textInput, ocrResultIds: [other.id] });
  held.release(); assert.notEqual((await first).id, (await second).id); assert.equal(f.requests.length, 3);
  const changed = holdFetch(); f.respond(changed.fetch); const original = f.service.suggest({ ...f.textInput, ocrResultIds: [ocr.id] }), rejected = assert.rejects(original, isCode('SOURCE_CHANGED')); await changed.started;
  if (ocr.output.kind !== 'ocr') throw Error('Expected OCR');
  db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify({ ...ocr, output: { ...ocr.output, text: 'Linen', lines: [{ ...ocr.output.lines[0], text: 'Linen' }] } }), ocr.id); db.close();
  const updated = f.service.suggest({ ...f.textInput, ocrResultIds: [ocr.id] }); changed.release(); await rejected; await updated; assert.equal(f.requests.length, 5);
});

test('provider disable cancels every shared waiter and an already-aborted caller never starts an attempt', async t => {
  const held = holdFetch(), f = await fixture(t, { fetch: held.fetch }); f.enable('deepseek');
  const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(f.service.suggest(f.textInput, cancelled.signal), isCode('CANCELLED')); assert.equal(f.requests.length, 0);
  const callers = Promise.allSettled([f.service.suggest(f.textInput), f.service.suggest(f.textInput)]); await held.started; f.service.setEnabled({ id: 'deepseek', enabled: false });
  assert.ok((await callers).every(r => r.status === 'rejected' && isCode('DISABLED')(r.reason))); held.release(); assert.equal(f.requests.length, 1);
});
