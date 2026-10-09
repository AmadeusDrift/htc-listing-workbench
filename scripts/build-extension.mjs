import { build } from 'esbuild';
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { COLLECTION_EXTENSION_PUBLIC_KEY, COLLECTION_NATIVE_HOST } from '../src/shared/collection-identity.ts';

export async function buildExtension({ destination = resolve('dist-extension'), testHost } = {}) {
  const testMode = testHost !== undefined;
  const output = resolve(destination);
  if (testMode && (!/^com\.htc\.workbench\.collection\.test_[a-z0-9]{12}$/.test(testHost) || !output.startsWith(resolve('.test-data') + sep))) throw new Error('Test extension must use an isolated host and .test-data directory');
  if (!testMode && output !== resolve('dist-extension')) throw new Error('Production extension output must be dist-extension');
  await mkdir(output, { recursive: true });
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  await build({ entryPoints: ['extension/worker.ts', 'extension/popup.ts'], outdir: output, bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', minifySyntax: true, legalComments: 'none', define: { __HTC_TEST_FIXTURES__: String(testMode), __HTC_NATIVE_HOST__: JSON.stringify(testHost ?? COLLECTION_NATIVE_HOST) } });
  for (const file of ['popup.html', 'popup.css']) await cp(join('extension', file), join(output, file));
  const manifest = { manifest_version: 3, name: 'HTC 1688 采集助手' + (testMode ? ' · 本地样例测试' : ''), version: pkg.version.split('-')[0], version_name: pkg.version,
    description: '主动读取当前商品，预览后保存到 HTC 本机采集箱。', key: COLLECTION_EXTENSION_PUBLIC_KEY,
    permissions: ['activeTab', 'scripting', 'nativeMessaging'], background: { service_worker: 'worker.js', type: 'module' }, action: { default_title: '读取到 HTC 采集箱', default_popup: 'popup.html' },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; connect-src 'none'; img-src 'self'; style-src 'self'" },
    ...(testMode ? { host_permissions: ['http://127.0.0.1/*'] } : {}) };
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return output;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(`Extension built: ${await buildExtension()}`);
