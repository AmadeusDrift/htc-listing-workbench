import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, inventory, jsonDigest, manifestName, reserveOutput, verifyInventory } from './release-verification.mjs';
import { buildReceipt, verifySource } from './release-source.mjs';
import { noticesText } from './licenses.mjs';

export const buildDirectories = ['dist', 'dist-electron'];
export const requiredRuntime = ['electron.exe', 'version', 'icudtl.dat', 'resources.pak', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'ffmpeg.dll', 'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll', 'LICENSE', 'LICENSES.chromium.html', 'locales/en-US.pak', 'resources/default_app.asar'];
export function candidateGuide(pkg, source) {
  return `# HTC 候选制品（未启用）\n\n版本 ${pkg.version}；源码 ${source.commit}。\n\n此目录为独立验收候选，不替换当前安装包或启动器。完整性与来源见“${manifestName}”。\n由源码 scripts/verify-package.mjs 校验；由 scripts/e2e-release-candidate.mjs 在新隔离目录验收。不要直接启动本目录 EXE 进行离线验收：RED_E2E 只隐藏窗口，不禁网。\n\n旧浏览器/C#采集接入已停用，历史回执仍可读取。妙手合成导入格式位于“导入模板”。历史业务/验收资料不随包分发。\n`;
}
export async function buildFiles(snapshot) {
  const result = [];
  for (const dir of buildDirectories) result.push(...(await inventory(join(snapshot, dir))).map(f => ({ ...f, path: `${dir}/${f.path}` })));
  for (const file of ['dist/index.html', 'dist-electron/main.cjs', 'dist-electron/preload.cjs']) assert.ok(result.some(f => f.path === file), `Missing build input: ${file}`);
  return result;
}
export async function verifyBuild(repo, snapshot) {
  const source = await verifySource(repo, snapshot), build = JSON.parse(await readFile(join(snapshot, buildReceipt), 'utf8'));
  assert.equal(build.schema, 'htc-build/v1');
  assert.equal(build.command, 'npm run build'); assert.equal(build.platform, 'win32'); assert.equal(build.architecture, process.arch);
  assert.equal(build.sourceDigest, source.sourceDigest, 'Build source mismatch');
  assert.equal(build.sourceCommit, source.commit, 'Build commit mismatch');
  assert.equal(build.lockSha256, source.lockSha256, 'Build lock mismatch');
  assert.deepEqual(build.files, await buildFiles(snapshot), 'Build output mismatch');
  const dependencies = await inventory(join(snapshot, 'node_modules'));
  assert.equal(build.dependenciesDigest, jsonDigest(dependencies), 'Build dependencies changed');
  assert.deepEqual(build.runtime.files, await inventory(join(snapshot, 'node_modules/electron/dist')), 'Runtime changed');
  const electron = JSON.parse(await readFile(join(snapshot, 'node_modules/electron/package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(snapshot, 'package-lock.json'), 'utf8'));
  assert.equal(electron.version, lock.packages['node_modules/electron'].version, 'Electron differs from source lock');
  for (const path of requiredRuntime) assert.ok(build.runtime.files.some(f => f.path === path), `Missing runtime input: ${path}`);
  assert.equal(build.runtime.version, electron.version, 'Electron runtime version mismatch');
  assert.equal((await readFile(join(snapshot, 'node_modules/electron/dist/version'), 'utf8')).trim(), electron.version, 'Electron dist identity mismatch');
  return { source, build };
}
export async function assembleCandidate({ snapshot, runtime, output, pkg, notices, source, build, protectedRoots = [] }) {
  await reserveOutput(output, [snapshot, runtime, ...protectedRoots]);
  // Exclusive reservation remains on failure; an incomplete candidate is never reused.
  await inventory(runtime);
  for (const name of await readdir(runtime)) await cp(join(runtime, name), join(output, name), { recursive: true, force: false, errorOnExist: true });
  await rename(join(output, 'electron.exe'), join(output, 'HTC.exe'));
  const appRoot = join(output, 'resources/app'); await mkdir(appRoot);
  for (const directory of ['dist', 'dist-electron']) await cp(join(snapshot, directory), join(appRoot, directory), { recursive: true, force: false, errorOnExist: true, filter: file => !file.endsWith('.map') });
  await cp(join(snapshot, 'samples'), join(output, '导入模板'), { recursive: true, force: false, errorOnExist: true });
  await writeFile(join(appRoot, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, productName: 'HTC Workbench', main: pkg.main, private: true }, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(output, 'THIRD_PARTY_NOTICES.txt'), notices, { flag: 'wx' });
  await writeFile(join(output, '使用说明.md'), candidateGuide(pkg, source), { flag: 'wx' });
  const files = await inventory(output);
  const manifest = { schema: 'htc-package/v1', application: { name: pkg.name, version: pkg.version, platform: 'win32', architecture: process.arch },
    purpose: 'isolated candidate; not activated', source, build, omitted: ['machine-local historical docs', 'source maps', 'native generated source', 'test bootstrap and workspace'], files };
  await writeFile(join(output, manifestName), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  await verifyInventory(output, files, [manifestName]);
  return { manifestSha256: digest(await readFile(join(output, manifestName))), filesDigest: jsonDigest(files), files: files.length };
}

export async function verifyCandidate(repo, snapshot, candidate) {
  const { source, build } = await verifyBuild(repo, snapshot);
  const bytes = await readFile(join(candidate, manifestName)), manifest = JSON.parse(bytes);
  assert.equal(manifest.schema, 'htc-package/v1');
  assert.deepEqual(manifest.source, source, 'Package source provenance mismatch');
  assert.deepEqual(manifest.build, build, 'Package build provenance mismatch');
  const files = await verifyInventory(candidate, manifest.files, [manifestName]);
  const byPath = new Map(files.map(f => [f.path, f]));
  const expectedPaths = ['resources/app/package.json', '使用说明.md', 'THIRD_PARTY_NOTICES.txt'];
  function matches(file, target) {
    expectedPaths.push(target);
    const actual = byPath.get(target); assert.ok(actual, `Missing package input: ${target}`);
    assert.equal(actual.size, file.size, `Package input size mismatch: ${target}`);
    assert.equal(actual.sha256, file.sha256, `Package input digest mismatch: ${target}`);
  }
  for (const file of build.runtime.files) matches(file, file.path === 'electron.exe' ? 'HTC.exe' : file.path);
  for (const file of build.files) {
    if (file.path.endsWith('.map')) continue;
    assert.ok(file.path.startsWith('dist/')||file.path.startsWith('dist-electron/'),'Retired collection artifacts are not package inputs');
    matches(file, `resources/app/${file.path}`);
  }
  for (const file of source.files.filter(f => f.path.startsWith('samples/'))) matches(file, file.path.replace('samples/', '导入模板/'));
  const pkg = JSON.parse(await readFile(join(snapshot, 'package.json'), 'utf8'));
  assert.deepEqual(files.map(f => f.path).sort(), expectedPaths.sort(), 'Unexpected packaged input');
  assert.equal(await readFile(join(candidate, '使用说明.md'), 'utf8'), candidateGuide(pkg, source), 'Candidate guide mismatch');
  assert.equal(await readFile(join(candidate, 'THIRD_PARTY_NOTICES.txt'), 'utf8'), await noticesText(join(snapshot, 'node_modules')), 'Notices mismatch');
  assert.deepEqual(manifest.application, { name: pkg.name, version: pkg.version, platform: 'win32', architecture: build.architecture });
  assert.deepEqual(JSON.parse(await readFile(join(candidate, 'resources/app/package.json'), 'utf8')), { name: pkg.name, version: pkg.version, productName: 'HTC Workbench', main: pkg.main, private: true });
  assert.ok(files.every(file=>!file.path.startsWith('采集插件/')&&!file.path.startsWith('resources/app/dist-native/')),'Retired collection runtime must not ship');
  return { manifest, manifestSha256: digest(bytes), filesDigest: jsonDigest(files), files: files.length };
}
