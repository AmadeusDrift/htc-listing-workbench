import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const runFile = promisify(execFile);
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const jsonDigest = value => digest(JSON.stringify(value));
export const manifestName = '版本与摘要.json';
export const within = (root, target) => {
  const part = relative(resolve(root).toLowerCase(), resolve(target).toLowerCase());
  return part === '' || (!part.startsWith('..') && !isAbsolute(part));
};
export function safeRelative(path) {
  assert.equal(typeof path, 'string', 'Invalid manifest path');
  assert.ok(path && !path.includes('\\') && !path.startsWith('/') && !path.includes(':'), `Invalid path: ${path}`);
  for (const segment of path.split('/')) assert.ok(segment && segment !== '.' && segment !== '..' &&
    !/[. ]$|[\x00-\x1f<>"|?*]/.test(segment) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment), `Invalid path: ${path}`);
  return path;
}
export async function assertNoLinkParents(path) {
  let current = resolve(path);
  while (true) {
    const info = await lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    assert.ok(!info?.isSymbolicLink(), `Link/reparse path rejected: ${current}`);
    if (dirname(current) === current) break;
    current = dirname(current);
  }
}
async function rejectReparseTree(root) {
  if (process.platform !== 'win32') return;
  // Node identifies symlinks/junctions; Windows also has other reparse types.
  const literal = resolve(root).replaceAll("'", "''");
  const command = `$ErrorActionPreference='Stop'; $items=@(Get-Item -LiteralPath '${literal}' -Force)+@(Get-ChildItem -LiteralPath '${literal}' -Force -Recurse); if ($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Link/reparse tree rejected' }`;
  await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, maxBuffer: 1024 * 1024 });
}
export async function inventory(root, excluded = []) {
  await assertNoLinkParents(root); await rejectReparseTree(root);
  const result = [], folded = new Set(), exclude = new Set(excluded);
  async function visit(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      const path = safeRelative(prefix + name), absolute = join(directory, name), info = await lstat(absolute);
      assert.ok(!info.isSymbolicLink(), `Link/reparse file rejected: ${path}`);
      const lower = path.toLowerCase(); assert.ok(!folded.has(lower), `Duplicate path: ${path}`); folded.add(lower);
      if (info.isDirectory()) await visit(absolute, path + '/');
      else {
        assert.ok(info.isFile(), `Unsupported file: ${path}`);
        if (!exclude.has(path)) result.push({ path, size: info.size, sha256: digest(await readFile(absolute)) });
      }
    }
  }
  await visit(resolve(root)); return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export async function verifyInventory(root, expected, excluded = []) {
  assert.ok(Array.isArray(expected), 'Invalid file manifest');
  const folded = new Set();
  for (const file of expected) {
    safeRelative(file.path); const lower = file.path.toLowerCase();
    assert.ok(!folded.has(lower), `Duplicate path: ${file.path}`); folded.add(lower);
    assert.ok(Number.isSafeInteger(file.size) && file.size >= 0, 'Invalid file size');
    assert.match(file.sha256, /^[a-f0-9]{64}$/, 'Invalid file digest');
  }
  const actual = await inventory(root, excluded), sorted = [...expected].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  assert.deepEqual(actual.map(f => f.path), sorted.map(f => f.path), 'Package file set differs');
  for (let i = 0; i < actual.length; i++) {
    assert.equal(actual[i].size, sorted[i].size, `File size differs: ${actual[i].path}`);
    assert.equal(actual[i].sha256, sorted[i].sha256, `File digest differs: ${actual[i].path}`);
  }
  return actual;
}
export async function reserveOutput(output, protectedRoots = []) {
  assert.ok(isAbsolute(output), 'Output path must be absolute');
  assert.ok(!/^[/\\]{2}/.test(output), 'UNC output path rejected');
  const target = resolve(output);
  assert.ok(target !== parse(target).root && !output.split(/[\\/]/).includes('..'), 'Invalid output path');
  for (const root of protectedRoots) assert.ok(!within(root, target) && !within(target, root), 'Output overlaps protected path');
  await assertNoLinkParents(target);
  // Parent must already exist; never recursively create/merge an output tree.
  await realpath(dirname(target));
  await mkdir(target).catch(error => { if (error.code === 'EEXIST') throw Error('Output already exists'); throw error; });
  return target;
}
export function cli(names) {
  const args = process.argv.slice(2), result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; assert.ok(names.includes(key) && args[i + 1] && !args[i + 1].startsWith('--') && !result[key], `Usage: ${names.map(n => `${n} <path>`).join(' ')}`);
    result[key] = resolve(args[i + 1]);
  }
  for (const name of names) assert.ok(result[name], `Missing required ${name}`);
  return result;
}
