import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const url = new URL('../scripts/release-source.mjs', import.meta.url).href;
async function api() { const value = await import(url).catch(() => null); assert.ok(value, 'source provenance must be checked against Git objects'); return value; }
async function fixture(t: test.TestContext) {
  await mkdir(resolve('.test-data'), { recursive: true });
  const repo = await mkdtemp(resolve('.test-data/release-source-'));
  assert.ok(!relative(resolve('.test-data'), repo).startsWith('..'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8', windowsHide: true });
  git('init', '-q'); await writeFile(join(repo, '.gitignore'), 'artifacts/\n.env\n');
  await writeFile(join(repo, 'package.json'), '{"name":"synthetic-release","version":"1.0.0","main":"dist-electron/main.cjs"}');
  await writeFile(join(repo, 'package-lock.json'), '{"lockfileVersion":3}');
  await writeFile(join(repo, 'README.md'), 'Synthetic source');
  git('add', '--', '.gitignore', 'package.json', 'package-lock.json', 'README.md');
  git('-c', 'user.name=Release Test', '-c', 'user.email=release-test@example.invalid', 'commit', '-qm', 'Synthetic source');
  await mkdir(join(repo, 'artifacts')); await writeFile(join(repo, '.env'), 'synthetic-secret-do-not-copy');
  return { repo, git, output: join(repo, 'artifacts/run') };
}
test('tracked-only archive binds exact Git tree/blobs and excludes ignored local material', async t => {
  const s = await api(), f = await fixture(t), result = await s.createSnapshot(f.repo, f.output);
  assert.equal(result.source.commit, f.git('rev-parse', 'HEAD').trim());
  assert.equal(result.source.tree, f.git('rev-parse', 'HEAD^{tree}').trim());
  await assert.rejects(readFile(join(result.snapshot, '.env')), /ENOENT/);
  await s.verifySource(f.repo, result.snapshot);
  await writeFile(join(result.snapshot, 'README.md'), 'tampered');
  await assert.rejects(s.verifySource(f.repo, result.snapshot), /source|blob|digest/i);
});

async function buildFixture(t: test.TestContext) {
  const s = await api(), f = await fixture(t);
  await writeFile(join(f.repo, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/electron': { version: '44.4.5' } } }));
  await mkdir(join(f.repo, 'src/shared'), { recursive: true }); await mkdir(join(f.repo, 'samples'));
  await writeFile(join(f.repo, 'src/shared/collection-identity.ts'), "export const key = 'synthetic-extension-key';");
  await writeFile(join(f.repo, 'samples/miaoshou.template.json'), '{"appKey":"","appSecret":""}');
  f.git('add', '--', 'package-lock.json', 'src', 'samples'); f.git('-c', 'user.name=Release Test', '-c', 'user.email=release-test@example.invalid', 'commit', '-qm', 'Synthetic lock');
  const { snapshot, source } = await s.createSnapshot(f.repo, f.output);
  const packageUrl = new URL('../scripts/release-package.mjs', import.meta.url).href, packageApi = await import(packageUrl);
  const filesUrl = new URL('../scripts/release-verification.mjs', import.meta.url).href, filesApi = await import(filesUrl);
  for (const directory of ['dist', 'dist-electron', 'dist-native', 'dist-extension', 'node_modules/electron/dist/locales', 'node_modules/electron/dist/resources']) await mkdir(join(snapshot, directory), { recursive: true });
  for (const file of ['dist/index.html', 'dist-electron/main.cjs', 'dist-electron/preload.cjs', 'dist-native/HTC.CollectionHost.exe', 'dist-extension/manifest.json', 'dist-extension/worker.js', 'dist-extension/popup.js', 'dist-extension/popup.html', 'dist-extension/popup.css']) await writeFile(join(snapshot, file), 'synthetic-build');
  await writeFile(join(snapshot, 'node_modules/electron/package.json'), '{"version":"44.4.5"}');
  const licenses: Record<string, string> = { 'require-from-string': 'license', 'basic-ftp': 'LICENSE.txt', 'pdf-lib': 'LICENSE.md', '@pdf-lib/standard-fonts': 'LICENSE.md', 'tslib': 'LICENSE.txt' };
  for (const name of ['react', 'react-dom', 'scheduler', 'lucide-react', 'ajv', 'ajv-formats', 'fast-deep-equal', 'fast-uri', 'json-schema-traverse', 'require-from-string', 'basic-ftp', 'pdf-lib', '@pdf-lib/standard-fonts', '@pdf-lib/upng', 'pako', 'tslib']) {
    await mkdir(join(snapshot, 'node_modules', name), { recursive: true });
    await writeFile(join(snapshot, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
    await writeFile(join(snapshot, 'node_modules', name, licenses[name] || 'LICENSE'), 'Synthetic license');
  }
  await mkdir(join(snapshot, 'node_modules/pako/lib/zlib'), { recursive: true });
  await writeFile(join(snapshot, 'node_modules/pako/lib/zlib/inflate.js'), '// (C) 1995 synthetic\n// 3. synthetic');
  await writeFile(join(snapshot, 'dist-extension/manifest.json'), JSON.stringify({ permissions: ['activeTab', 'scripting', 'nativeMessaging'], key: 'synthetic-extension-key', version_name: '1.0.0' }));
  for (const path of packageApi.requiredRuntime) await writeFile(join(snapshot, 'node_modules/electron/dist', path), path === 'version' ? '44.4.5' : 'synthetic-runtime');
  const build = { schema: 'htc-build/v1', sourceCommit: source.commit, sourceDigest: source.sourceDigest, lockSha256: source.lockSha256,
    command: 'npm run build', platform: 'win32', architecture: process.arch, dependenciesDigest: filesApi.jsonDigest(await filesApi.inventory(join(snapshot, 'node_modules'))),
    runtime: { version: '44.4.5', files: await filesApi.inventory(join(snapshot, 'node_modules/electron/dist')) }, files: await packageApi.buildFiles(snapshot) };
  await writeFile(join(snapshot, '.release-build.json'), JSON.stringify(build));
  return { ...f, snapshot, source, build, packageApi, filesApi };
}
test('build validation binds actual outputs, dependency bytes, runtime identity and source commit', async t => {
  const f = await buildFixture(t); await f.packageApi.verifyBuild(f.repo, f.snapshot);
  const main = join(f.snapshot, 'dist-electron/main.cjs'); await writeFile(main, 'tampered-build');
  await assert.rejects(f.packageApi.verifyBuild(f.repo, f.snapshot), /Build output mismatch/);
  await writeFile(main, 'synthetic-build');
  const receipt = join(f.snapshot, '.release-build.json'); await writeFile(receipt, JSON.stringify({ ...f.build, sourceCommit: '0'.repeat(40) }));
  await assert.rejects(f.packageApi.verifyBuild(f.repo, f.snapshot), /Build commit mismatch/);
  await writeFile(receipt, JSON.stringify(f.build));
  await writeFile(join(f.snapshot, 'node_modules/electron/dist/electron.exe'), 'changed-runtime');
  await assert.rejects(f.packageApi.verifyBuild(f.repo, f.snapshot), /dependencies changed/);
});
test('missing runtime, version mismatch and nested untracked source inputs fail closed', async t => {
  const f = await buildFixture(t);
  const receipt = join(f.snapshot, '.release-build.json');
  await writeFile(receipt, JSON.stringify({ ...f.build, runtime: { ...f.build.runtime, version: '1.0.0' } }));
  await assert.rejects(f.packageApi.verifyBuild(f.repo, f.snapshot), /runtime version mismatch/);
  await writeFile(receipt, JSON.stringify(f.build));
  await writeFile(join(f.snapshot, 'src/injected.ts'), 'untracked');
  await assert.rejects(f.packageApi.verifyBuild(f.repo, f.snapshot), /Unexpected source files/); await rm(join(f.snapshot, 'src/injected.ts'));
  await rm(join(f.snapshot, 'node_modules/electron/dist/icudtl.dat'));
  await assert.rejects(f.packageApi.verifyBuild(f.repo, f.snapshot), /dependencies changed|Runtime changed/);
});
test('candidate verification works independent of cwd and rejects rehashed runtime or extra payloads', async t => {
  const f = await buildFixture(t), output = join(f.output, 'candidate');
  const licensesUrl = new URL('../scripts/licenses.mjs', import.meta.url).href, licenses = await import(licensesUrl);
  const pkg = JSON.parse(await readFile(join(f.snapshot, 'package.json'), 'utf8'));
  await f.packageApi.assembleCandidate({ snapshot: f.snapshot, runtime: join(f.snapshot, 'node_modules/electron/dist'), output, pkg,
    notices: await licenses.noticesText(join(f.snapshot, 'node_modules')), source: f.source, build: f.build });
  await f.packageApi.verifyCandidate(f.repo, f.snapshot, output);
  const verify = resolve('scripts/verify-package.mjs');
  const child = execFileSync(process.execPath, [verify, '--source-repo', f.repo, '--snapshot', f.snapshot, '--package-root', output], { cwd: f.output, windowsHide: true, encoding: 'utf8' });
  assert.equal(JSON.parse(child).sourceCommit, f.source.commit);
  const manifestFile = join(output, '版本与摘要.json'), original = await readFile(manifestFile, 'utf8'), manifest = JSON.parse(original);
  await writeFile(join(output, 'HTC.exe'), 'rehashed-malicious-runtime');
  manifest.files = await f.filesApi.inventory(output, ['版本与摘要.json']); await writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(f.packageApi.verifyCandidate(f.repo, f.snapshot, output), /Package input (size|digest) mismatch/);
  await writeFile(join(output, 'HTC.exe'), 'synthetic-runtime');
  await writeFile(join(output, 'history-secret.txt'), 'synthetic-private-history');
  manifest.files = await f.filesApi.inventory(output, ['版本与摘要.json']); await writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(f.packageApi.verifyCandidate(f.repo, f.snapshot, output), /Unexpected packaged input/);
});
test('dirty source and forged provenance cannot claim a matching commit', async t => {
  const s = await api(), f = await fixture(t);
  await writeFile(join(f.repo, 'README.md'), 'dirty');
  await assert.rejects(s.createSnapshot(f.repo, f.output), /clean/i);
  await writeFile(join(f.repo, 'README.md'), 'Synthetic source');
  const result = await s.createSnapshot(f.repo, f.output);
  const file = join(result.snapshot, '.release-source.json'), receipt = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...receipt, tree: '0'.repeat(40) }));
  await assert.rejects(s.verifySource(f.repo, result.snapshot), /tree/i);
  await writeFile(file, JSON.stringify(receipt));
  await writeFile(join(result.snapshot, 'injected.js'), 'untracked');
  await assert.rejects(s.verifySource(f.repo, result.snapshot), /unexpected/i);
});
