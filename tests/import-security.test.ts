import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseImport, exportProductData } from '../src/main/import-export.ts';
import { authorizeSender, assetIdFromUrl, managedAssetPath, publicError } from '../src/main/security.ts';
import { inspectRaster } from '../src/main/image-format.ts';
import { checkReadiness } from '../src/main/readiness.ts';
import { WorkspaceStore } from '../src/main/store.ts';

test('CSV 以商品编号分组，支持引号中的逗号/换行并保留 0 库存', () => {
  const products = parseImport('\uFEFFproductKey,title,sku,originalSpec,purchasePrice,inventory\r\na,"收纳袋,棉质",RED-A,"白色\n大号",0.0350,0\r\na,"收纳袋,棉质",RED-B,蓝色,1.20,\r\n', 'csv');
  assert.equal(products.length, 1);
  assert.equal(products[0].variants.length, 2);
  assert.equal(products[0].variants[0].originalSpec, '白色\n大号');
  assert.equal(products[0].variants[0].inventory, 0);
  assert.equal(products[0].variants[1].inventory, null);
});
test('格式损坏、同商品冲突、重复 SKU 的导入明确拒绝', () => {
  assert.throws(() => parseImport('productKey,title,sku\na,"未闭合,B', 'csv'), /CSV|引号/);
  assert.throws(() => parseImport('productKey,title,sku\na,商品 A,A\na,商品 B,B', 'csv'), /不一致|冲突/);
  assert.throws(() => parseImport('{"version":99,"products":[]}', 'json'), /版本|格式/);
  assert.throws(() => parseImport('productKey,title,sku\na,A,DUP\nb,B,DUP', 'csv'), /SKU.*重复|重复.*SKU/);
});
test('对外错误保留可修正的 CSV、JSON 和 SKU 提示，隐藏未知内部错误', t => {
  const cases: [string, string, RegExp][] = [
    ['productKey,title,sku\na,商品', 'csv', /CSV 第 2 行列数/],
    ['{broken', 'json', /JSON 格式不正确/],
    ['productKey,title,sku\na,商品 A,A\na,商品 A,A', 'csv', /SKU不能重复/],
  ];
  for (const [contents, format, message] of cases) {
    assert.throws(() => parseImport(contents, format), error => { assert.match(publicError(error), message); return true; });
  }
  mkdirSync(resolve('.test-data'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.test-data'), 'public-error-')); const store = new WorkspaceStore(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const p = store.createProduct();
  assert.throws(() => store.importProducts(parseImport(`productKey,title,sku\na,已有商品,${p.variants[0].sku}`, 'csv')),
    error => { assert.match(publicError(error), /SKU 已存在.*不同的 SKU/); return true; });
  assert.doesNotMatch(publicError(new Error('内部路径 C:/private/secret.sqlite')), /private|secret/);
  assert.match(publicError(Object.assign(new Error('denied C:/private/secret.sqlite'), { code: 'EACCES' })), /权限/);
});
test('整个导入批次遇到已有 SKU 冲突时回滚，导出可重新解析', t => {
  mkdirSync(resolve('.test-data'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.test-data'), 'import-')); const store = new WorkspaceStore(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const p = store.createProduct();
  const products = parseImport(`productKey,title,sku,originalSpec,purchasePrice\na,第一件,FRESH,白色,1\nb,第二件,${p.variants[0].sku},蓝色,2`, 'csv');
  assert.throws(() => store.importProducts(products), /SKU/);
  assert.equal(store.listProducts().length, 1);
  assert.equal(store.listAudit().length, 1);
  const roundtrip = parseImport(JSON.stringify(exportProductData(p)), 'json');
  assert.equal(roundtrip[0].title, p.title);
  assert.notEqual(roundtrip[0].variants[0].id, p.variants[0].id);
});
test('IPC 拒绝其他窗口、子 frame、相似文件路径及远程网页', () => {
  const trusted = { senderId: 10, windowId: 10, isMainFrame: true, url: 'file:///C:/red/dist/index.html' };
  assert.doesNotThrow(() => authorizeSender(trusted, trusted.url));
  for (const bad of [{ ...trusted, senderId: 11 }, { ...trusted, isMainFrame: false },
    { ...trusted, url: trusted.url + '.evil' }, { ...trusted, url: 'https://example.com/' }, { ...trusted, url: trusted.url + '?x=1' }]) {
    assert.throws(() => authorizeSender(bad, trusted.url), /来源/);
  }
});
test('图片协议只接收素材 ID，拒绝路径穿越和任意文件读取', () => {
  const id = randomUUID(); assert.equal(assetIdFromUrl(`red-asset://image/${id}`), id);
  for (const url of ['red-asset://image/../../secret', 'file:///C:/secret', `red-asset://image/${id}?path=secret`, 'red-asset://other/x']) {
    assert.throws(() => assetIdFromUrl(url));
  }
  assert.equal(managedAssetPath(resolve('.test-data'), `assets/${id}.png`), resolve('.test-data', 'assets', `${id}.png`));
  assert.throws(() => managedAssetPath(resolve('.test-data'), '../outside.png'));
  assert.throws(() => managedAssetPath(resolve('.test-data'), 'C:/secret.png'));
});
test('图片头校验拒绝 SVG、伪装扩展名和像素炸弹', () => {
  assert.throws(() => inspectRaster(Buffer.from('<svg></svg>')), /PNG|JPEG/);
  const png = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(13, 8); png.write('IHDR', 12);
  png.writeUInt32BE(800, 16); png.writeUInt32BE(600, 20);
  assert.deepEqual(inspectRaster(png), { mimeType: 'image/png', extension: 'png', width: 800, height: 600 });
  png.writeUInt32BE(50000, 16); assert.throws(() => inspectRaster(png), /像素|尺寸/);
});
test('本地资料检查不会伪报 Amazon 校验或连接成功', t => {
  mkdirSync(resolve('.test-data'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.test-data'), 'check-')); const store = new WorkspaceStore(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const result = checkReadiness(store.createProduct());
  assert.equal(result.mode, 'local'); assert.equal(result.amazonConnected, false);
  assert.ok(result.checks.some(check => !check.passed));
  assert.match(result.note, /Amazon/);
});
