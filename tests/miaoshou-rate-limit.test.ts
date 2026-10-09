import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceStore } from '../src/main/store.ts';
import { MiaoshouService } from '../src/main/miaoshou/service.ts';
import { listFixture, detailFixture, testMiaoshouStorage } from './helpers/miaoshou-fixture.ts';

const credentials = { appKey: 'rate-test-app', appSecret: 'rate-test-secret-should-not-be-shown' };
const response = (raw: unknown) => new Response(JSON.stringify(raw));
function setup(transport: typeof fetch) {
  let elapsed = 0;
  const clock = { now: () => elapsed, sleep: async (ms: number, signal: AbortSignal) => {
    if (signal.aborted) throw signal.reason; elapsed += ms;
  } };
  const directory = mkdtempSync(join(tmpdir(), 'htc-ms-rate-')), store = new WorkspaceStore(directory);
  const starts: number[] = [];
  const dependencies = { rateLimitClock: clock, fetch: (async (url, init) => { starts.push(elapsed); return transport(url, init); }) as typeof fetch };
  const service = new MiaoshouService(directory, store, testMiaoshouStorage(), dependencies);
  service.importConfig(credentials);
  return { service, starts, advance(ms: number) { elapsed += ms; },
    async dispose() { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('list and detail share a paced queue, and concurrent reads do not get BUSY', async () => {
  const env = setup((async url => response(String(url).endsWith('_list') ? listFixture() : detailFixture())) as typeof fetch);
  try {
    const results = await Promise.allSettled([
      env.service.listProducts({ pageNo: 1, pageSize: 20 }),
      env.service.previewProduct({ id: '90071992547409931' }),
      env.service.listProducts({ pageNo: 1, pageSize: 20 }),
    ]);
    assert.ok(results.every(r => r.status === 'fulfilled'));
    assert.deepEqual(env.starts, [0, 1200, 2400]);
  } finally { await env.dispose(); }
});

test('account per-second limits retry only within the three-attempt bound', async () => {
  let attempts = 0;
  const env = setup((async () => ++attempts < 3
    ? response({ result: 'fail', code: 'accountApiQpsRateLimit', message: credentials.appSecret }) : response(listFixture())) as typeof fetch);
  try {
    assert.equal((await env.service.listProducts({ pageNo: 1, pageSize: 20 })).total, 1);
    assert.deepEqual(env.starts, [0, 3000, 9000]);
  } finally { await env.dispose(); }
  const exhausted = setup((async () => response({ result: 'fail', code: 'apiQpsRateLimit' })) as typeof fetch);
  try {
    await assert.rejects(exhausted.service.listProducts({ pageNo: 1, pageSize: 20 }), { code: 'LIMIT' });
    assert.equal(exhausted.starts.length, 3);
  } finally { await exhausted.dispose(); }
});

test('per-minute limits wait a full conservative minute before retrying', async () => {
  let attempts = 0;
  const env = setup((async () => ++attempts === 1 ? response({ result: 'fail', code: 'accountQpmRateLimit' }) : response(listFixture())) as typeof fetch);
  try {
    await env.service.listProducts({ pageNo: 1, pageSize: 20 }); assert.deepEqual(env.starts, [0, 60000]);
  } finally { await env.dispose(); }
});

test('daily limits do not retry or let the next queued product hit the exhausted account', async () => {
  const env = setup((async () => response({ result: 'fail', code: 'accountQpdRateLimit' })) as typeof fetch);
  try {
    const results = await Promise.allSettled([env.service.listProducts({ pageNo: 1, pageSize: 20 }), env.service.previewProduct({ id: '123' })]);
    assert.equal(env.starts.length, 1);
    assert.ok(results.every(r => r.status === 'rejected' && r.reason.code === 'LIMIT' && /每日/.test(r.reason.message)));
  } finally { await env.dispose(); }
});

test('HTTP Retry-After is honored; long cooldowns fail promptly and remain shared', async () => {
  let attempts = 0;
  const env = setup((async () => ++attempts === 1 ? new Response('', { status: 429, headers: { 'retry-after': '5' } }) : response(listFixture())) as typeof fetch);
  try {
    await env.service.listProducts({ pageNo: 1, pageSize: 20 }); assert.deepEqual(env.starts, [0, 5000]);
  } finally { await env.dispose(); }
  attempts = 0;
  const long = setup((async () => ++attempts === 1 ? new Response('', { status: 429, headers: { 'retry-after': '120' } }) : response(listFixture())) as typeof fetch);
  try {
    await assert.rejects(long.service.listProducts({ pageNo: 1, pageSize: 20 }), { code: 'LIMIT' });
    await assert.rejects(long.service.listProducts({ pageNo: 1, pageSize: 20 }), { code: 'LIMIT' });
    assert.equal(long.starts.length, 1);
    long.advance(120000);
    assert.equal((await long.service.listProducts({ pageNo: 1, pageSize: 20 })).total, 1);
  } finally { await long.dispose(); }
});

test('authentication and bad data errors are not retried', async () => {
  for (const raw of [{ result: 'fail', code: 'signInvalid' }, { result: 'success', code: 'success', data: {} }]) {
    const env = setup((async () => response(raw)) as typeof fetch);
    try { await assert.rejects(env.service.listProducts({ pageNo: 1, pageSize: 20 })); assert.equal(env.starts.length, 1); }
    finally { await env.dispose(); }
  }
});

test('disconnect cancels both an in-flight read and a queued read without a second transport call', async () => {
  const env = setup((() => new Promise<Response>(() => {})) as typeof fetch);
  try {
    const results = Promise.allSettled([env.service.listProducts({ pageNo: 1, pageSize: 20 }), env.service.listProducts({ pageNo: 1, pageSize: 20 })]);
    await new Promise<void>(resolve => setImmediate(resolve));
    env.service.disconnect();
    const settled = await results;
    assert.ok(settled.every(r => r.status === 'rejected' && r.reason.code === 'CHANGED'));
    assert.equal(env.starts.length, 1); assert.equal(env.service.busy, false);
  } finally { await env.dispose(); }
});
