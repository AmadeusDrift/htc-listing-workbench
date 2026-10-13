import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installedDependencyRoot } from './release-dependencies.mjs';
import { cli, inventory, jsonDigest, runFile } from './release-verification.mjs';
import { assertClean, buildReceipt, createSnapshot, verifySource } from './release-source.mjs';
import { buildFiles } from './release-package.mjs';

// One command owns archive, dependency copy and build; there is no --commit label
// or accept-existing-dist mode. Run from a committed clean source repository.
const args = cli(['--source-repo', '--output']), repo = args['--source-repo'];
assert.equal(process.platform, 'win32', 'Windows build required');
const { snapshot, source } = await createSnapshot(repo, args['--output']);
const startedAt = new Date().toISOString();
const dependencyRoot=installedDependencyRoot(repo);
const dependencies = await inventory(dependencyRoot);
await cp(dependencyRoot, join(snapshot, 'node_modules'), { recursive: true, force: false, errorOnExist: true });
assert.equal(jsonDigest(await inventory(join(snapshot, 'node_modules'))), jsonDigest(dependencies), 'Dependency copy mismatch');
const lock = JSON.parse(await readFile(join(snapshot, 'package-lock.json'), 'utf8'));
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path) continue;
  const installed = await readFile(join(snapshot, path, 'package.json'), 'utf8').catch(error => {
    if (error.code === 'ENOENT' && entry.optional) return null; throw error;
  });
  if (installed) assert.equal(JSON.parse(installed).version, entry.version, `Installed dependency differs from lock: ${path}`);
}
await verifySource(repo, snapshot);
const command = process.env.ComSpec || 'cmd.exe';
const npmVersion = (await runFile(command, ['/d', '/s', '/c', 'npm --version'], { cwd: snapshot, windowsHide: true })).stdout.trim();
const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE;
let outcome;
try { outcome = await runFile(command, ['/d', '/s', '/c', 'npm run build'], { cwd: snapshot, env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }); }
catch (error) {
  await writeFile(join(args['--output'], 'build.log'), `${error.stdout || ''}\n${error.stderr || ''}`, { flag: 'wx' }); throw error;
}
await writeFile(join(args['--output'], 'build.log'), `${outcome.stdout}\n${outcome.stderr}`, { flag: 'wx' });
await verifySource(repo, snapshot); await assertClean(repo);
assert.equal(jsonDigest(await inventory(join(snapshot, 'node_modules'))), jsonDigest(dependencies), 'Build modified dependency inputs');
const runtimeVersion = JSON.parse(await readFile(join(snapshot, 'node_modules/electron/package.json'), 'utf8')).version;
assert.equal(runtimeVersion, (await readFile(join(snapshot, 'node_modules/electron/dist/version'), 'utf8')).trim());
const toolchain=Object.fromEntries(await Promise.all(['typescript','vite','esbuild'].map(async name=>[name,JSON.parse(await readFile(join(snapshot,'node_modules',name,'package.json'),'utf8')).version])));
const build = { schema: 'htc-build/v1', sourceCommit: source.commit, sourceDigest: source.sourceDigest, lockSha256: source.lockSha256,
  command: 'npm run build', node: process.version, npm: npmVersion, platform: process.platform, architecture: process.arch,
  toolchain, startedAt, finishedAt: new Date().toISOString(), dependenciesDigest: jsonDigest(dependencies),
  runtime: { version: runtimeVersion, files: await inventory(join(snapshot, 'node_modules/electron/dist')) }, files: await buildFiles(snapshot) };
await writeFile(join(snapshot, buildReceipt), JSON.stringify(build, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ snapshot, sourceCommit: source.commit, sourceTree: source.tree, sourceDigest: source.sourceDigest, buildDigest: jsonDigest(build) }, null, 2));
