import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { cleanupManagedBackups, registerManagedBackup } from '../src/main/backup-retention.ts';
import type { BackupRetention, ManagedBackup } from '../src/main/backup-retention.ts';
import { UserFacingError } from '../src/shared/errors.ts';

const DAY = 86_400_000;
const START = Date.parse('2026-01-01T00:00:00.000Z');
const at = (days: number) => new Date(START + days * DAY).toISOString();
const MAGIC = Buffer.from('HTC-BACKUP-1\n');
const DEFAULT_RETENTION: BackupRetention = { amazonDays: 30, logDays: 365, dataOldestAt: at(0), expiresAt: at(30) };

async function fixture(t: test.TestContext) {
  const boundary = resolve('.test-data');
  await mkdir(boundary, { recursive: true });
  const root = await mkdtemp(join(boundary, 'backup-retention-'));
  t.after(async () => {
    const local = relative(boundary, root);
    assert.ok(local && !local.startsWith('..') && !local.includes('\\') && !local.includes('/'));
    await rm(root, { recursive: true, force: true });
  });
  const directory = join(root, 'data'); await mkdir(directory);
  return { root, directory, registry: join(directory, '.backup-registry.json') };
}

async function backup(root: string, name: string, retention = DEFAULT_RETENTION): Promise<ManagedBackup> {
  const bytes = Buffer.concat([MAGIC, Buffer.alloc(80, 71), Buffer.from(name), Buffer.from(randomUUID())]);
  const path = join(root, `${name}.htcbackup`);
  await writeFile(path, bytes);
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length, createdAt: at(1), retention: { ...retention } };
}

test('只删除到期且内容校验一致的受管加密备份，原始商品库不变', async t => {
  const { root, directory } = await fixture(t);
  const owned = await backup(root, 'owned'), source = join(directory, 'red.sqlite');
  await writeFile(source, 'original-product-library');
  await registerManagedBackup(directory, owned);
  assert.equal(await cleanupManagedBackups(directory, 30, START + 30 * DAY - 1), 0);
  assert.equal(await cleanupManagedBackups(directory, 30, START + 30 * DAY), 1);
  await assert.rejects(lstat(owned.path), { code: 'ENOENT' });
  assert.equal(await readFile(source, 'utf8'), 'original-product-library');
  assert.equal(await cleanupManagedBackups(directory, 30, START + 31 * DAY), 0);
});

test('同名文件内容被替换后，即使长度相同也不会删除', async t => {
  const { root, directory, registry } = await fixture(t), owned = await backup(root, 'changed');
  await registerManagedBackup(directory, owned);
  const replacement = await readFile(owned.path); replacement[replacement.length - 1] ^= 1;
  await writeFile(owned.path, replacement);
  assert.equal(await cleanupManagedBackups(directory, 30, START + 31 * DAY), 0);
  assert.deepEqual(await readFile(owned.path), replacement);
  assert.ok((await readFile(registry, 'utf8')).includes(owned.sha256));
});

test('未登记文件、手工复制文件和不含 Amazon 数据的备份均保留', async t => {
  const { root, directory } = await fixture(t);
  const owned = await backup(root, 'owned'), untracked = await backup(root, 'untracked');
  const permanent = await backup(root, 'permanent', { ...DEFAULT_RETENTION, dataOldestAt: null, expiresAt: null });
  const copied = join(root, 'manual-copy.htcbackup'); await copyFile(owned.path, copied);
  await registerManagedBackup(directory, owned); await registerManagedBackup(directory, permanent);
  assert.equal(await cleanupManagedBackups(directory, 1, START + 600 * DAY), 1);
  for (const path of [untracked.path, permanent.path, copied]) assert.ok((await lstat(path)).isFile());
});

test('缩短保留设置会提前到期，之后放宽设置不会延长已经确定的期限', async t => {
  const { root, directory } = await fixture(t), owned = await backup(root, 'shortened');
  await registerManagedBackup(directory, owned);
  assert.equal(await cleanupManagedBackups(directory, 10, START + 5 * DAY), 0);
  assert.equal(await cleanupManagedBackups(directory, 548, START + 10 * DAY), 1);
});

test('放宽设置不会延长备份原始到期时间', async t => {
  const { root, directory } = await fixture(t), owned = await backup(root, 'original-expiry');
  await registerManagedBackup(directory, owned);
  assert.equal(await cleanupManagedBackups(directory, 548, START + 30 * DAY), 1);
});

test('同一加密文件重复登记不会撤销已经缩短的保留期限', async t => {
  const { root, directory } = await fixture(t), owned = await backup(root, 'repeat-registration');
  await registerManagedBackup(directory, owned);
  assert.equal(await cleanupManagedBackups(directory, 10, START + 5 * DAY), 0);
  await registerManagedBackup(directory, owned);
  assert.equal(await cleanupManagedBackups(directory, 548, START + 10 * DAY), 1);
});

test('只有日志的备份使用已记录期限，不因数据保留设置提前删除', async t => {
  const { root, directory } = await fixture(t);
  const owned = await backup(root, 'logs-only', { ...DEFAULT_RETENTION, dataOldestAt: null, expiresAt: at(365) });
  await registerManagedBackup(directory, owned);
  assert.equal(await cleanupManagedBackups(directory, 1, START + 30 * DAY), 0);
  assert.equal(await cleanupManagedBackups(directory, 548, START + 365 * DAY), 1);
});

test('并发登记保留全部备份，同路径后续登记替换原摘要', async t => {
  const { root, directory } = await fixture(t);
  const entries = await Promise.all(Array.from({ length: 16 }, (_, index) => backup(root, `concurrent-${index}`)));
  await Promise.all(entries.map(entry => registerManagedBackup(directory, entry)));
  const replacement = await backup(root, 'concurrent-0', { ...DEFAULT_RETENTION, dataOldestAt: null, expiresAt: null });
  await registerManagedBackup(directory, replacement);
  assert.equal(await cleanupManagedBackups(directory, 30, START + 31 * DAY), 15);
  assert.ok((await lstat(replacement.path)).isFile());
});

test('登记先于落盘时，清理保留缺失文件记录并在文件就绪后再次处理', async t => {
  const { root, directory } = await fixture(t), owned = await backup(root, 'pending');
  const bytes = await readFile(owned.path); await unlink(owned.path);
  await registerManagedBackup(directory, owned);
  assert.equal(await cleanupManagedBackups(directory, 30, START + 31 * DAY), 0);
  await writeFile(owned.path, bytes);
  assert.equal(await cleanupManagedBackups(directory, 30, START + 31 * DAY), 1);
});

test('登记先于原子替换时，旧文件摘要不匹配不会丢失新备份的管理记录', async t => {
  const { root, directory } = await fixture(t), owned = await backup(root, 'replacement-pending');
  const bytes = await readFile(owned.path); await writeFile(owned.path, 'old-file');
  await registerManagedBackup(directory, owned);
  assert.equal(await cleanupManagedBackups(directory, 30, START + 31 * DAY), 0);
  await writeFile(owned.path, bytes);
  assert.equal(await cleanupManagedBackups(directory, 30, START + 31 * DAY), 1);
});

test('已移动的备份和备份路径处的目录不会被清理', async t => {
  const { root, directory } = await fixture(t), owned = await backup(root, 'moved');
  await registerManagedBackup(directory, owned);
  const moved = join(root, 'moved-elsewhere.htcbackup'); await rename(owned.path, moved);
  await mkdir(owned.path); await writeFile(join(owned.path, 'keep.txt'), 'keep');
  assert.equal(await cleanupManagedBackups(directory, 30, START + 31 * DAY), 0);
  assert.ok((await lstat(moved)).isFile());
  assert.equal(await readFile(join(owned.path, 'keep.txt'), 'utf8'), 'keep');
});

test('匹配摘要但不含加密备份头的文件不会被删除', async t => {
  const { root, directory } = await fixture(t), owned = await backup(root, 'no-magic');
  const bytes = Buffer.alloc(owned.byteSize, 88); await writeFile(owned.path, bytes);
  await registerManagedBackup(directory, { ...owned, sha256: createHash('sha256').update(bytes).digest('hex') });
  assert.equal(await cleanupManagedBackups(directory, 30, START + 31 * DAY), 0);
  assert.deepEqual(await readFile(owned.path), bytes);
});

test('登记参数必须为绝对备份路径、有效摘要、大小和保留元数据', async t => {
  const { root, directory, registry } = await fixture(t), valid = await backup(root, 'validation');
  const invalid: ManagedBackup[] = [
    { ...valid, path: 'relative.htcbackup' }, { ...valid, path: join(root, 'red.sqlite') },
    { ...valid, sha256: 'not-a-digest' }, { ...valid, byteSize: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, byteSize: -1 }, { ...valid, createdAt: 'yesterday' },
    { ...valid, retention: { ...valid.retention, amazonDays: 0 } },
    { ...valid, retention: { ...valid.retention, expiresAt: null } },
  ];
  for (const entry of invalid) await assert.rejects(registerManagedBackup(directory, entry), UserFacingError);
  await assert.rejects(lstat(registry), { code: 'ENOENT' });
  assert.ok((await lstat(valid.path)).isFile());
});

test('损坏、无效结构和超限的注册表不会被当作空表覆盖', async t => {
  const { root, directory, registry } = await fixture(t), owned = await backup(root, 'corrupt-registry');
  for (const contents of ['{broken', '{}', '{"version":999,"backups":[]}', '{"version":1,"backups":[{}]}', ' '.repeat(4 * 1024 * 1024 + 1)]) {
    await writeFile(registry, contents);
    await assert.rejects(cleanupManagedBackups(directory, 30, START + 31 * DAY), UserFacingError);
    await assert.rejects(registerManagedBackup(directory, owned), UserFacingError);
    assert.equal(await readFile(registry, 'utf8'), contents);
  }
  assert.ok((await lstat(owned.path)).isFile());
});

test('注册表必须为普通文件，不能覆盖同名目录', async t => {
  const { root, directory, registry } = await fixture(t), owned = await backup(root, 'registry-directory');
  await mkdir(registry); await writeFile(join(registry, 'keep.txt'), 'keep');
  await assert.rejects(cleanupManagedBackups(directory, 30, START + 31 * DAY), UserFacingError);
  await assert.rejects(registerManagedBackup(directory, owned), UserFacingError);
  assert.equal(await readFile(join(registry, 'keep.txt'), 'utf8'), 'keep');
});

test('权限错误保留记录，恢复访问后可再次清理', async t => {
  const { root, directory } = await fixture(t), owned = await backup(root, 'retry-permission');
  await registerManagedBackup(directory, owned);
  const probe = await open(owned.path, 'r'), prototype = Object.getPrototypeOf(probe), read = probe.read;
  await probe.close();
  const denied = t.mock.method(prototype, 'read', async function (this: Awaited<ReturnType<typeof open>>, ...args: unknown[]) {
    if ((await this.stat()).size === owned.byteSize) throw Object.assign(new Error('access denied'), { code: 'EACCES' });
    return Reflect.apply(read, this, args);
  });
  assert.equal(await cleanupManagedBackups(directory, 30, START + 31 * DAY), 0);
  assert.ok((await lstat(owned.path)).isFile());
  denied.mock.restore();
  assert.equal(await cleanupManagedBackups(directory, 30, START + 31 * DAY), 1);
});

test('备份父目录被替换成 junction 后不删除指向的文件', async t => {
  const { root, directory } = await fixture(t), exports = join(root, 'exports'); await mkdir(exports);
  const owned = await backup(exports, 'linked-parent'); await registerManagedBackup(directory, owned);
  const original = join(root, 'original-exports'); await rename(exports, original);
  try { await symlink(original, exports, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('需要创建链接的系统权限'); return; } throw error; }
  assert.equal(await cleanupManagedBackups(directory, 30, START + 31 * DAY), 0);
  assert.ok((await lstat(join(original, 'linked-parent.htcbackup'))).isFile());
});

test('备份文件被替换成符号链接后保留目标文件', async t => {
  const { root, directory } = await fixture(t), owned = await backup(root, 'symlink');
  await registerManagedBackup(directory, owned);
  const original = join(root, 'original.htcbackup'); await rename(owned.path, original);
  try { await symlink(original, owned.path, 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('需要创建链接的系统权限'); return; } throw error; }
  assert.equal(await cleanupManagedBackups(directory, 30, START + 31 * DAY), 0);
  assert.ok((await lstat(original)).isFile());
});

test('空目录没有注册表时清理为零且不创建注册表', async t => {
  const { directory, registry } = await fixture(t);
  assert.equal(await cleanupManagedBackups(directory, 30, START + 31 * DAY), 0);
  await assert.rejects(lstat(registry), { code: 'ENOENT' });
});
