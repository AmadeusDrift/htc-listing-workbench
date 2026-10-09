import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { FtpConnectionPool, BasicFtpTransport } from '../src/main/hosting/ftp.ts';
import { createPublicImageProbe, isPublicIp, validatePublicUrl } from '../src/main/hosting/public-probe.ts';
import type { FtpClient } from '../src/main/hosting/ftp.ts';
import type { HostingProfile } from '../src/shared/hosting-contracts.ts';
import { abortable } from '../src/main/hosting/errors.ts';

const profile: HostingProfile = { id: 'alpha', name: 'Alpha', host: 'ftp.example.test', port: 2121, secure: true, remoteRoot: '/', publicBaseUrl: 'https://images.example.com/AAA/', enabled: true, configured: true, generation: 1 };
const credentials = { username: 'test-user', password: 'test-password' };
function fakeClient(onClose = () => {}): FtpClient {
  let closed = false;
  return { get closed() { return closed; }, async access() { closed = false; }, close() { closed = true; onClose(); }, async ensureDir() {}, async cd() {}, async uploadFrom() {}, async size() { return 33; } };
}

test('connection pool caps the shared total at five and never runs overlapping commands on a client', async () => {
  let created = 0, active = 0, peak = 0;
  const busy = new Set<FtpClient>();
  const pool = new FtpConnectionPool({ createClient: () => { created++; return fakeClient(); } });
  await Promise.all(Array.from({ length: 21 }, (_n, i) => pool.use({ ...profile, id: i % 2 ? 'alpha' : 'beta' }, credentials, async client => {
    assert.equal(busy.has(client), false); busy.add(client); active++; peak = Math.max(peak, active);
    await new Promise<void>(resolve => setTimeout(resolve, 5)); active--; busy.delete(client);
  }, new AbortController().signal)));
  assert.ok(peak <= 5); assert.ok(created <= 7, 'idle connections are reused across multiple waves');
  await pool.close();
});

test('pool reuses a client and forwards secure true without downgrading TLS', async () => {
  const options: unknown[] = []; let creates = 0;
  const pool = new FtpConnectionPool({ createClient: () => { creates++; const client = fakeClient(); client.access = async value => { options.push(value); }; return client; } });
  const transport = new BasicFtpTransport(pool), signal = new AbortController().signal;
  await transport.upload(profile, credentials, '/20260930/file.png', Buffer.alloc(33), signal);
  assert.equal(await transport.size(profile, credentials, '/20260930/file.png', signal), 33);
  assert.equal(creates, 1); assert.equal((options[0] as { secure: boolean }).secure, true);
  assert.equal((options[0] as { secureOptions: { rejectUnauthorized: boolean } }).secureOptions.rejectUnauthorized, true);
  await transport.close();
});

test('aborting a queued or active FTP operation cancels it without leaking a lease', async () => {
  let entered!: () => void; const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const pool = new FtpConnectionPool({ maxConnections: 1, createClient: () => fakeClient() });
  const active = new AbortController(), queued = new AbortController();
  const a = pool.use(profile, credentials, async () => { entered(); await new Promise<void>(() => {}); }, active.signal);
  await enteredPromise;
  const b = pool.use(profile, credentials, async () => assert.fail('cancelled queued action ran'), queued.signal);
  queued.abort(); await assert.rejects(b, /取消/); active.abort(); await assert.rejects(a, /取消/);
  await pool.use(profile, credentials, async () => {}, new AbortController().signal); await pool.close();
});

test('already aborted operations still observe their underlying asynchronous rejection', async t => {
  const controller = new AbortController(); controller.abort();
  const unhandled: unknown[] = [], observe = (error: unknown) => unhandled.push(error);
  process.on('unhandledRejection', observe); t.after(() => process.removeListener('unhandledRejection', observe));
  const original = new Promise<void>((_resolve, reject) => queueMicrotask(() => reject(new Error('late client rejection'))));
  await assert.rejects(abortable(original, controller.signal), /取消/);
  await new Promise<void>(resolve => setTimeout(resolve, 20));
  assert.deepEqual(unhandled, []);
});

test('public image URLs reject credentials, redirects-to-private candidates and nonpublic IP ranges', () => {
  for (const ip of ['0.0.0.0', '10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1']) assert.equal(isPublicIp(ip), false, ip);
  assert.equal(isPublicIp('8.8.8.8'), true); assert.equal(isPublicIp('2606:4700:4700::1111'), true);
  for (const url of ['http://images.example.com/a.png', 'https://localhost/a.png', 'https://127.0.0.1/a.png', 'https://user:pass@images.example.com/a.png', 'https://images.example.com/a.png?q=x', 'https://images.example.com/a.png#x']) assert.throws(() => validatePublicUrl(url));
});

test('public probe rejects a private DNS answer before opening a socket', async () => {
  let requests = 0;
  const probe = createPublicImageProbe({ lookup: async () => [{ address: '127.0.0.1', family: 4 }], request: (() => { requests++; throw new Error('should not call'); }) as never });
  await assert.rejects(probe({ url: 'https://images.example.com/a.png', sha256: 'a'.repeat(64), byteSize: 33, mimeType: 'image/png' }, new AbortController().signal), /公网/);
  assert.equal(requests, 0);
});

test('public probe pins verified DNS and requires full matching hash and MIME with bounded bytes', async () => {
  const bytes = Buffer.from('image bytes'), sha256 = createHash('sha256').update(bytes).digest('hex');
  let pinned = false;
  function probeFor(body: Buffer, status = 200, mime = 'image/png') {
    return createPublicImageProbe({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: ((_url: URL, options: { lookup: (host: string, options: unknown, callback: (...args: unknown[]) => void) => void }, callback: (response: Readable) => void) => {
      options.lookup('images.example.com', {}, (_error, address) => { pinned = address === '8.8.8.8'; });
      const response = Object.assign(Readable.from([body]), { statusCode: status, headers: { 'content-type': mime, 'content-length': String(body.length) } });
      const request = Object.assign(new EventEmitter(), { end() { queueMicrotask(() => callback(response)); }, destroy() {}, setTimeout() {} });
      return request;
    }) as never });
  }
  const expected = { url: 'https://images.example.com/a.png', sha256, byteSize: bytes.length, mimeType: 'image/png' };
  await probeFor(bytes)(expected, new AbortController().signal); assert.equal(pinned, true);
  await assert.rejects(probeFor(Buffer.from('wrong bytes'))(expected, new AbortController().signal), /内容/);
  await assert.rejects(probeFor(bytes, 200, 'text/html')(expected, new AbortController().signal), /内容/);
  await assert.rejects(probeFor(bytes, 302)(expected, new AbortController().signal), /公网/);
  await assert.rejects(probeFor(Buffer.alloc(100))(expected, new AbortController().signal), /内容/);
});
