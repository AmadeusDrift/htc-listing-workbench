import { createRequire } from 'node:module';
import { cp as copy, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { writeNotices } from './licenses.mjs';

if (process.platform !== 'win32') throw new Error('此便携构建脚本目前只支持 Windows');
if (!existsSync('dist/index.html') || !existsSync('dist-electron/main.cjs') || !existsSync('dist-native/HTC.CollectionHost.exe') || !existsSync('dist-extension/manifest.json')) throw new Error('请先运行 npm run build');
process.env.electron_config_cache = resolve('.cache/electron');
const require = createRequire(import.meta.url);
// Historical acceptance documents stay on the original machine; a fresh clone packages without them.
const skippedDocuments = new Set();
async function cp(source, target, options) {
  if (/^docs[\\/]/.test(source) && !existsSync(source)) { skippedDocuments.add(resolve(target)); return; }
  await copy(source, target, options);
}
const runtime = dirname(require('electron'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const releaseRoot = resolve('release'), destination = resolve(releaseRoot, `HTC-${pkg.version}-win32-${process.arch}`);
if (!destination.startsWith(releaseRoot + sep)) throw new Error('构建输出路径无效');
await mkdir(destination, { recursive: true });
if (!existsSync(join(destination, 'HTC.exe'))) {
  await cp(runtime, destination, { recursive: true });
  await rename(join(destination, 'electron.exe'), join(destination, 'HTC.exe'));
}
const appRoot = join(destination, 'resources', 'app'); await mkdir(appRoot, { recursive: true });
await cp('dist', join(appRoot, 'dist'), { recursive: true, force: true });
await cp('dist-electron', join(appRoot, 'dist-electron'), { recursive: true, force: true, filter: path => !path.endsWith('.map') });
await cp('dist-native', join(appRoot, 'dist-native'), { recursive: true, force: true });
await cp('dist-extension', join(destination, '采集插件'), { recursive: true, force: true });
await writeFile(join(appRoot, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, productName: 'HTC Workbench', main: pkg.main, private: true }, null, 2));
await writeFile(join(destination, '使用说明.md'), (await readFile('README.md', 'utf8')).replaceAll('](docs/1.0.0', '](1.0.0').replaceAll('](docs/0.13.0', '](0.13.0').replaceAll('](docs/0.12.0', '](0.12.0').replaceAll('](docs/0.11.0', '](0.11.0').replaceAll('](docs/0.10.3', '](0.10.3').replaceAll('](docs/0.10.2看图与生图交接', '](0.10.2看图与生图交接').replaceAll('](docs/0.10.1模型列表与代理兼容', '](0.10.1模型列表与代理兼容').replaceAll('](docs/0.10.0自动图片流程与验收', '](0.10.0自动图片流程与验收').replaceAll('](docs/0.9.2生图接口接入与验收', '](0.9.2生图接口接入与验收').replaceAll('](docs/0.9.1采集箱优化与验收', '](0.9.1采集箱优化与验收').replaceAll('](docs/0.9.0界面升级与验收', '](0.9.0界面升级与验收').replaceAll('](docs/无图片上传预览联调', '](无图片上传预览联调').replaceAll('](docs/商品数据接口接入与测试', '](商品数据接口接入与测试').replaceAll('](docs/商品数据独立入口与页面拆分', '](商品数据独立入口与页面拆分').replaceAll('](docs/备货与回流', '](备货与回流').replaceAll('](docs/妙手', '](妙手').replaceAll('](docs/连接', '](连接').replaceAll('](docs/Amazon下载与VPN', '](Amazon下载与VPN').replaceAll('](docs/2026-10-06真实', '](2026-10-06真实').replaceAll('](docs/Schema驱动AI字段', '](Schema驱动AI字段').replaceAll('](docs/规则预览与批量同步', '](规则预览与批量同步').replaceAll('](docs/12件妙手商品', '](12件妙手商品').replaceAll('](docs/重新保存凭据后真实联调', '](重新保存凭据后真实联调'));
await cp('docs/工作区与界面验收记录.md', join(destination, '验收记录.md'));
await cp('docs/阶段1验收记录.md', join(destination, 'Amazon工作流验收记录.md'));
await cp('docs/后台执行与FTP验收记录.md', join(destination, '后台执行与FTP验收记录.md'));
for (const file of ['后台补强与正式测试.md', '本地诊断与故障验收记录.md', '采集插件安装与测试.md', '采集插件验收记录.md', '妙手与Amazon统一测试指南.md', '妙手采集接入验收记录.md']) await cp(join('docs', file), join(destination, file));
await writeFile(join(destination, '启动独立测试.cmd'), '@echo off\r\nset "RED_DATA_DIR=%~dp0test-workspace"\r\nset "RED_E2E="\r\nset "RED_COLLECTION_TEST_HOST="\r\nset "RED_DEV_SERVER_URL="\r\nset "ELECTRON_RUN_AS_NODE="\r\nstart "" "%~dp0HTC.exe"\r\n', 'utf8');
await writeNotices();
await cp('THIRD_PARTY_NOTICES.txt', join(destination, 'THIRD_PARTY_NOTICES.txt'));
await cp('samples', join(destination, '导入模板'), { recursive: true, force: true });
const digestPaths = ['resources/app/dist-electron/main.cjs', 'resources/app/dist-electron/preload.cjs', 'resources/app/dist-native/HTC.CollectionHost.exe', 'resources/app/dist/index.html', '采集插件/manifest.json', '采集插件/worker.js', '采集插件/popup.js', '采集插件/popup.html', '采集插件/popup.css', '启动独立测试.cmd', '导入模板/miaoshou.template.json', '妙手与Amazon统一测试指南.md', '妙手采集接入验收记录.md'];
const digests = [];
await cp('docs/0.9.0界面升级与验收.md', join(destination, '0.9.0界面升级与验收.md'));
await cp('docs/0.9.1采集箱优化与验收.md', join(destination, '0.9.1采集箱优化与验收.md'));
await cp('docs/0.9.2生图接口接入与验收.md', join(destination, '0.9.2生图接口接入与验收.md'));
await cp('docs/0.10.0自动图片流程与验收.md', join(destination, '0.10.0自动图片流程与验收.md'));
digestPaths.push('0.10.0自动图片流程与验收.md');
for (const file of ['1.0.0FTP配置与验收.md', '0.13.0七图规划与验收.md', '0.12.0自动上架规则与验收.md', '0.11.0完整自动上架与商品标签.md', '0.10.3侵权风险检测.md', '0.10.2看图与生图交接.md', '0.10.1模型列表与代理兼容.md', '图片下载与Fake-IP代理兼容验收_2026-10-08.md']) { await cp(join('docs', file), join(destination, file)); digestPaths.push(file); }
digestPaths.push('0.9.2生图接口接入与验收.md');
digestPaths.push('0.9.1采集箱优化与验收.md');
digestPaths.push('0.9.0界面升级与验收.md');
await cp('docs/商品数据接口接入与测试_2026-10-07.md', join(destination, '商品数据接口接入与测试_2026-10-07.md'));
digestPaths.push('商品数据接口接入与测试_2026-10-07.md');
await cp('docs/商品数据独立入口与页面拆分_2026-10-07.md', join(destination, '商品数据独立入口与页面拆分_2026-10-07.md'));
digestPaths.push('商品数据独立入口与页面拆分_2026-10-07.md');
await cp('docs/备货与回流框架验收_2026-10-07.md', join(destination, '备货与回流框架验收_2026-10-07.md'));
digestPaths.push('备货与回流框架验收_2026-10-07.md');
for (const file of ['无图片上传预览联调_2026-10-07.md', '规则预览与批量同步验收_2026-10-07.md', '升级后凭据异常排查_2026-10-07.md', '12件妙手商品离线准备检查_2026-10-07.md', '重新保存凭据后真实联调_2026-10-07.md']) {
  await cp(join('docs', file), join(destination, file));
  digestPaths.push(file);
}
await cp('docs/连接配置与密钥填写.md', join(destination, '连接配置与密钥填写.md'));
await cp('docs/UI反馈统一验收记录.md', join(destination, 'UI反馈统一验收记录.md'));
await cp('docs/AI供应商共享连接验收记录.md', join(destination, 'AI供应商共享连接验收记录.md'));
await cp('docs/Amazon下载与VPN兼容验收记录.md', join(destination, 'Amazon下载与VPN兼容验收记录.md'));
await cp('docs/2026-10-06真实接口联调记录.md', join(destination, '2026-10-06真实接口联调记录.md'));
await cp('docs/Schema驱动AI字段验收记录.md', join(destination, 'Schema驱动AI字段验收记录.md'));
await cp('docs/妙手文字参数核查与限流修复_2026-10-07.md', join(destination, '妙手文字参数核查与限流修复_2026-10-07.md'));
digestPaths.push('妙手文字参数核查与限流修复_2026-10-07.md');
await cp('docs/妙手文字尺寸重量自动整理验收_2026-10-07.md', join(destination, '妙手文字尺寸重量自动整理验收_2026-10-07.md'));
digestPaths.push('妙手文字尺寸重量自动整理验收_2026-10-07.md');
digestPaths.push('Schema驱动AI字段验收记录.md');
digestPaths.push('Amazon下载与VPN兼容验收记录.md', '2026-10-06真实接口联调记录.md');
digestPaths.push('UI反馈统一验收记录.md', 'AI供应商共享连接验收记录.md');
digestPaths.push('连接配置与密钥填写.md', ...(await readdir('dist/assets')).map(file => `resources/app/dist/assets/${file}`));
for (const file of digestPaths) if (!skippedDocuments.has(resolve(destination, file))) digests.push({ file, sha256: createHash('sha256').update(await readFile(join(destination, file))).digest('hex') });
await writeFile(join(destination, '版本与摘要.json'), JSON.stringify({ version: pkg.version, generatedAt: new Date().toISOString(), platform: 'win32', architecture: process.arch, purpose: 'isolated manual testing', digests }, null, 2) + '\n');
if (skippedDocuments.size) console.log(`未找到 ${skippedDocuments.size} 份历史说明文档，已跳过（不影响程序本体）`);
console.log(`便携工作台已生成：${join(destination, 'HTC.exe')}`);
