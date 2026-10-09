import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { COLLECTION_EXTENSION_ID, COLLECTION_EXTENSION_PUBLIC_KEY } from '../src/shared/collection-identity.ts';
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const root = resolve('release', `HTC-${pkg.version}-win32-${process.arch}`);
const manifest = JSON.parse(await readFile(join(root, '版本与摘要.json'), 'utf8'));
assert.equal(manifest.version, pkg.version);
for (const entry of manifest.digests) assert.equal(createHash('sha256').update(await readFile(join(root, entry.file))).digest('hex'), entry.sha256, entry.file);
const extension = JSON.parse(await readFile(join(root, '采集插件/manifest.json'), 'utf8'));
assert.deepEqual(extension.permissions, ['activeTab', 'scripting', 'nativeMessaging']);
assert.equal(extension.host_permissions, undefined); assert.equal(extension.key, COLLECTION_EXTENSION_PUBLIC_KEY);
assert.equal(extension.version_name, pkg.version);
const worker = await readFile(join(root, '采集插件/worker.js'), 'utf8');
assert.equal(worker.includes('htc-fixture-source'), false); assert.equal(worker.includes('127.0.0.1'), false);
assert.equal(worker.includes('.test_'), false);
for (const file of await readdir(join(root, '采集插件'))) assert.deepEqual(await readFile(join(root, '采集插件', file)), await readFile(join('dist-extension', file)));
const launcher = await readFile(join(root, '启动独立测试.cmd'), 'utf8');
assert.ok(launcher.includes('set "RED_DATA_DIR=%~dp0test-workspace"'));
assert.ok(launcher.includes('set "RED_E2E="')); assert.ok(launcher.includes('set "RED_COLLECTION_TEST_HOST="'));
const app = JSON.parse(await readFile(join(root, 'resources/app/package.json'), 'utf8')); assert.equal(app.version, pkg.version);
for (const file of ['dist-electron/main.cjs', 'dist-electron/preload.cjs', 'dist-native/HTC.CollectionHost.exe', 'dist/index.html', ...(await readdir('dist/assets')).map(file => `dist/assets/${file}`)]) {
  assert.deepEqual(await readFile(join(root, 'resources/app', file)), await readFile(file), `Packaged build differs: ${file}`);
}
assert.deepEqual(Object.keys(JSON.parse(await readFile(join(root, '导入模板/miaoshou.template.json'), 'utf8'))).sort(), ['appKey', 'appSecret']);
assert.ok((await readFile(join(root, '妙手与Amazon统一测试指南.md'), 'utf8')).includes(pkg.version));
console.log(JSON.stringify({ package: root, version: pkg.version, digestsVerified: manifest.digests.length, extensionId: COLLECTION_EXTENSION_ID, testSourceExcluded: true, explicitTestLauncher: true }, null, 2));
