import test from 'node:test';
import assert from 'node:assert/strict';
import { BasicFtpTransport, FtpConnectionPool } from '../src/main/hosting/ftp.ts';
import type { HostingProfile } from '../src/shared/hosting-contracts.ts';
import { createLocalFtpServer } from './helpers/ftp-server.ts';

async function localFtp(t: test.TestContext, mode: 'normal' | 'bounce' | 'auth-fail' | 'timeout' = 'normal') {
  const server = await createLocalFtpServer({ mode }); t.after(() => server.close());
  const profile: HostingProfile = { id: 'alpha', name: 'Alpha', host: server.host, port: server.port, secure: false, remoteRoot: '/', publicBaseUrl: 'https://htc.185858.xyz/AAA/', configured: true, enabled: true, generation: 1 };
  return { ...server, profile };
}

test('real basic-ftp protocol logs in, creates directories, transfers bytes, checks SIZE and reuses the connection', async t => {
  const fixture = await localFtp(t), transport = new BasicFtpTransport(new FtpConnectionPool({ connectionTimeoutMs: 1000 }));
  t.after(() => transport.close());
  const credentials = { username: 'local-test', password: 'local-test-only' }, signal = new AbortController().signal, bytes = Buffer.from('local image fixture');
  assert.equal(await transport.size(fixture.profile, credentials, '/20260930/test/file.png', signal), null);
  assert.equal(await transport.upload(fixture.profile, credentials, '/20260930/test/file.png', bytes, signal), bytes.length);
  assert.equal(await transport.size(fixture.profile, credentials, '/20260930/test/file.png', signal), bytes.length);
  assert.deepEqual(fixture.files.get('/20260930/test/file.png'), bytes);
  assert.equal(fixture.connections(), 1); assert.ok(fixture.commands.includes('MKD')); assert.ok(fixture.commands.includes('EPSV'));
});

test('passive FTP cannot redirect its data connection to another host', async t => {
  const fixture = await localFtp(t, 'bounce'), transport = new BasicFtpTransport(new FtpConnectionPool({ connectionTimeoutMs: 500 }));
  t.after(() => transport.close());
  await assert.rejects(transport.upload(fixture.profile, { username: 'local-test', password: 'local-test-only' }, '/test/a.png', Buffer.from('image'), new AbortController().signal));
  assert.ok(fixture.commands.includes('PASV')); assert.equal(fixture.commands.includes('STOR'), false);
});

test('explicit TLS failure never downgrades to plaintext authentication', async t => {
  const fixture = await localFtp(t), transport = new BasicFtpTransport(new FtpConnectionPool({ connectionTimeoutMs: 500 }));
  t.after(() => transport.close());
  await assert.rejects(transport.size({ ...fixture.profile, secure: true }, { username: 'local-test', password: 'local-test-only' }, '/a.png', new AbortController().signal));
  assert.ok(fixture.commands.includes('AUTH')); assert.equal(fixture.commands.includes('USER'), false); assert.equal(fixture.commands.includes('PASS'), false);
});

test('FTP 530 is reported as a safe nonretryable authentication failure', async t => {
  const fixture = await localFtp(t, 'auth-fail'), transport = new BasicFtpTransport(new FtpConnectionPool({ connectionTimeoutMs: 500 }));
  t.after(() => transport.close());
  await assert.rejects(transport.size(fixture.profile, { username: 'local-test', password: 'local-test-only' }, '/a.png', new AbortController().signal), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'AUTH_FAILED');
});

test('basic-ftp socket timeouts map to the bounded CONNECT_TIMEOUT category', async t => {
  const fixture = await localFtp(t, 'timeout'), transport = new BasicFtpTransport(new FtpConnectionPool({ connectionTimeoutMs: 20 }));
  t.after(() => transport.close());
  await assert.rejects(transport.size(fixture.profile, { username: 'local-test', password: 'local-test-only' }, '/a.png', new AbortController().signal), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONNECT_TIMEOUT');
});

for (const action of ['abort', 'close'] as const) test(`immediate FTP ${action} does not start a login or emit an unhandled rejection`, async t => {
  const fixture = await localFtp(t), transport = new BasicFtpTransport(new FtpConnectionPool({ connectionTimeoutMs: 500 }));
  t.after(() => transport.close());
  const unhandled: unknown[] = [], observe = (error: unknown) => unhandled.push(error);
  process.on('unhandledRejection', observe); t.after(() => process.removeListener('unhandledRejection', observe));
  const controller = new AbortController();
  const pending = transport.size(fixture.profile, { username: 'local-test', password: 'local-test-only' }, '/a.png', controller.signal);
  if (action === 'abort') controller.abort(); else await transport.close();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CANCELLED');
  await new Promise<void>(resolve => setTimeout(resolve, 20));
  assert.deepEqual(unhandled, []); assert.equal(fixture.connections(), 0);
});
