import { constants, lstatSync, realpathSync, mkdirSync, openSync, closeSync, fstatSync, readdirSync, writeSync, fsyncSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep, join } from 'node:path';
import { UserFacingError } from '../shared/errors.ts';

function invalid(): never { throw new UserFacingError('恢复目录包含链接或路径身份发生变化，未安装备份'); }
function key(path: string): string { return process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path); }
function identity(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }

/** Pins the identity of each real directory used during restoration. Checks and
 * descriptor creation are synchronous so async checkpoints cannot replace a
 * checked parent between validation and open. No recursive mkdir follows links. */
export class RestorePathGuard {
  readonly root: string;
  private readonly directories = new Map<string, Stats>();
  constructor(root: string) {
    this.root = resolve(root);
    this.assertDirectory(this.root);
  }
  private inside(path: string): string {
    const value = resolve(path), local = relative(this.root, value);
    if (isAbsolute(local) || local === '..' || local.startsWith('..' + sep)) invalid();
    return value;
  }
  assertDirectory(path: string, create = false): void {
    const value = this.inside(path), local = relative(this.root, value);
    const parts = local ? local.split(sep) : [];
    let cursor = this.root;
    for (let index = -1; index < parts.length; index++) {
      if (index >= 0) cursor = join(cursor, parts[index]);
      let stat: Stats;
      try { stat = lstatSync(cursor); }
      catch (error) {
        if (!create || index < 0 || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        mkdirSync(cursor); stat = lstatSync(cursor);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink() || key(realpathSync(cursor)) !== key(cursor)) invalid();
      const prior = this.directories.get(key(cursor));
      if (prior && !identity(prior, stat)) invalid();
      this.directories.set(key(cursor), stat);
    }
  }
  assertFile(path: string, descriptor?: number): Stats {
    const value = this.inside(path); this.assertDirectory(dirname(value));
    const stat = lstatSync(value);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || key(realpathSync(value)) !== key(value)) invalid();
    if (descriptor !== undefined) {
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.nlink !== 1 || !identity(stat, opened)) invalid();
    }
    return stat;
  }
  openFile(path: string): number {
    const value = this.inside(path); this.assertDirectory(dirname(value), true);
    const descriptor = openSync(value, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { this.assertFile(value, descriptor); return descriptor; }
    catch (error) { closeSync(descriptor); throw error; }
  }
  assertTree(path = this.root): void {
    const value = this.inside(path), stat = lstatSync(value);
    if (stat.isSymbolicLink()) invalid();
    if (stat.isDirectory()) {
      this.assertDirectory(value);
      for (const name of readdirSync(value)) this.assertTree(join(value, name));
      this.assertDirectory(value);
    } else this.assertFile(value);
  }
}

/** Legacy V1 already holds each decoded file in memory; publish it through the
 * same pinned parent/descriptor checks as the streaming reader. */
export function writeRestoreFile(guard: RestorePathGuard, path: string, bytes: Buffer): void {
  const descriptor = guard.openFile(path);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      guard.assertFile(path, descriptor);
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (!written) throw new UserFacingError('恢复文件写入失败');
      offset += written;
    }
    guard.assertFile(path, descriptor); fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
}
