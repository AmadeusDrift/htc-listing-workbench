import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertNoLinkParents, digest, inventory, jsonDigest, reserveOutput, runFile, safeRelative, within } from './release-verification.mjs';

export const sourceReceipt = '.release-source.json';
export const buildReceipt = '.release-build.json';
export const generatedRoots = ['node_modules', 'dist', 'dist-electron', 'dist-native', 'dist-extension', '.cache', '.test-data', 'artifacts'];
async function git(repo, args) {
  return (await runFile('git', ['-c', `safe.directory=${resolve(repo)}`, '-C', resolve(repo), ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })).stdout;
}
export async function sourceObjects(repo, commit) {
  assert.match(commit, /^[a-f0-9]{40}$/, 'Source commit must be a full object ID');
  assert.equal((await git(repo, ['rev-parse', '--show-object-format'])).trim(), 'sha1', 'Unsupported Git object format');
  assert.equal((await git(repo, ['cat-file', '-t', commit])).trim(), 'commit', 'Source must name a commit');
  const tree = (await git(repo, ['rev-parse', `${commit}^{tree}`])).trim();
  const files = (await git(repo, ['ls-tree', '-rz', '--full-tree', commit])).split('\0').filter(Boolean).map(line => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(line);
    assert.ok(match, 'Source links, submodules and non-files are not allowed');
    const path = safeRelative(match[3]);
    assert.ok(!generatedRoots.includes(path.split('/')[0]) && !/^\.git(?:\/|$)|(?:^|\/)(?:credentials|data)(?:\/|$)|(?:^|\/)\.env(?:\.|$)/i.test(path.replace(/\.env\.example$/, 'env-example')), `Unsafe tracked source: ${path}`);
    return { path, mode: match[1], blob: match[2] };
  });
  assert.ok(files.length, 'Empty source tree');
  assert.equal(new Set(files.map(f => f.path.toLowerCase())).size, files.length, 'Duplicate source paths');
  return { commit, tree, files };
}
export async function assertClean(repo) {
  assert.equal((await git(repo, ['rev-parse', '--show-toplevel'])).trim().replaceAll('\\', '/').toLowerCase(), resolve(repo).replaceAll('\\', '/').toLowerCase(), 'Explicit repository root required');
  assert.equal((await git(repo, ['status', '--porcelain=v1', '--untracked-files=normal'])).trim(), '', 'Source repository must be clean');
}
export async function verifySource(repo, snapshot) {
  await assertNoLinkParents(snapshot);
  const receipt = JSON.parse(await readFile(join(snapshot, sourceReceipt), 'utf8'));
  assert.equal(receipt.schema, 'htc-source/v1');
  const objects = await sourceObjects(repo, receipt.commit);
  assert.equal(receipt.tree, objects.tree, 'Source tree mismatch');
  assert.deepEqual(receipt.objects, objects.files, 'Source blob list mismatch');
  const files = [];
  for (const object of objects.files) {
    const absolute = join(snapshot, object.path); await assertNoLinkParents(absolute);
    const bytes = await readFile(absolute);
    assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), object.blob, `Source blob mismatch: ${object.path}`);
    files.push({ path: object.path, size: bytes.length, sha256: digest(bytes) });
  }
  assert.deepEqual(receipt.files, files, 'Source digest list mismatch');
  assert.equal(receipt.sourceDigest, jsonDigest(files), 'Source manifest digest mismatch');
  assert.equal(receipt.lockSha256, files.find(f => f.path === 'package-lock.json')?.sha256, 'Source lock mismatch');
  const expected = new Set([...objects.files.map(f => f.path.split('/')[0]), sourceReceipt, buildReceipt, ...generatedRoots]);
  for (const name of await readdir(snapshot)) assert.ok(expected.has(name), `Unexpected snapshot input: ${name}`);
  // Reject extra files inside tracked directories, not just additions at the root.
  for (const directory of new Set(objects.files.filter(f => f.path.includes('/')).map(f => f.path.split('/')[0]))) {
    const actual = await inventory(join(snapshot, directory));
    assert.deepEqual(actual.map(f => `${directory}/${f.path}`).sort(), objects.files.filter(f => f.path.startsWith(`${directory}/`)).map(f => f.path).sort(), `Unexpected source files in ${directory}`);
  }
  return receipt;
}
export function assertArtifactLocation(repo, output) {
  assert.ok(within(join(repo, 'artifacts'), output) || within(join(repo, '.test-data'), output), 'Release output must be in repository artifacts or .test-data');
}
export async function createSnapshot(repo, output) {
  repo = resolve(repo); await assertClean(repo); assertArtifactLocation(repo, output);
  const commit = (await git(repo, ['rev-parse', 'HEAD'])).trim(), objects = await sourceObjects(repo, commit);
  await reserveOutput(output, [join(repo, 'release'), join(repo, '.git')]);
  const archive = join(output, 'source.tar'), snapshot = join(output, 'source');
  await git(repo, ['archive', '--format=tar', `--output=${archive}`, commit]);
  await mkdir(snapshot);
  await runFile('tar', ['-xf', archive, '-C', snapshot], { windowsHide: true, maxBuffer: 1024 * 1024 });
  // Git for Windows archive applies eol attributes. Materialize canonical blob
  // bytes after extraction so the snapshot has an exact, portable object binding.
  const blobs = await new Promise((done, reject) => {
    const child = spawn('git', ['-c', `safe.directory=${repo}`, '-C', repo, 'cat-file', '--batch'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [], errors = []; child.stdout.on('data', value => chunks.push(value)); child.stderr.on('data', value => errors.push(value));
    child.once('error', reject); child.once('close', code => code === 0 ? done(Buffer.concat(chunks)) : reject(Error(Buffer.concat(errors).toString())));
    child.stdin.end(objects.files.map(f => f.blob).join('\n') + '\n');
  });
  let offset = 0;
  for (const object of objects.files) {
    const end = blobs.indexOf(10, offset), header = blobs.subarray(offset, end).toString();
    const match = /^([a-f0-9]{40}) blob (\d+)$/.exec(header); assert.ok(match && match[1] === object.blob, 'Invalid Git blob response');
    const size = Number(match[2]), bytes = blobs.subarray(end + 1, end + 1 + size); offset = end + size + 2;
    await writeFile(join(snapshot, object.path), bytes);
  }
  const files = await inventory(snapshot);
  // ls-tree and inventory have the same bytewise lexical ordering for these source paths.
  const ordered = objects.files.map(object => files.find(file => file.path === object.path));
  assert.ok(ordered.every(Boolean) && ordered.length === files.length, 'Archive differs from tracked source');
  const source = { schema: 'htc-source/v1', commit, tree: objects.tree, objects: objects.files, files: ordered,
    sourceDigest: jsonDigest(ordered), lockSha256: ordered.find(f => f.path === 'package-lock.json')?.sha256 };
  assert.ok(source.lockSha256, 'Tracked package-lock.json required');
  await writeFile(join(snapshot, sourceReceipt), JSON.stringify(source, null, 2) + '\n', { flag: 'wx' });
  await verifySource(repo, snapshot); await assertClean(repo);
  assert.equal((await git(repo, ['rev-parse', 'HEAD'])).trim(), commit, 'Source HEAD changed during archive');
  return { snapshot, source };
}
