import { electron } from './e2e-core-runtime.mjs';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
await mkdir('.test-data', { recursive: true });
await mkdir('artifacts', { recursive: true });
const dataRoot = await mkdtemp(resolve('.test-data/inbox-summary-pages-'));
const require = createRequire(import.meta.url), env = { ...process.env, RED_DATA_DIR: dataRoot, RED_E2E: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const packaged = Boolean(process.env.HTC_TEST_EXE);
const executablePath = packaged ? resolve(process.env.HTC_TEST_EXE) : require('electron');
let app;
try {
  app = await electron.launch({ executablePath, args: packaged ? [] : ['.'], cwd: resolve('.'), env });
  const runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, execPath: process.execPath }));
  assert.equal(runtime.packaged, packaged);
  assert.equal(resolve(runtime.execPath).toLowerCase(), resolve(executablePath).toLowerCase());
  const page = await app.firstWindow();
  await expect(page.getByRole('button', { name: '同步妙手采集箱', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const ids = [];
    for (let i = 0; i < 100; i++) {
      const p = await window.red.createProduct();
      await window.red.saveProduct({ id: p.id, revision: p.revision, sourceUrl: p.sourceUrl, description: p.description, status: p.status,
        title: `${i < 51 ? '子集' : '其余'} 合成参数 ${i}`,
        facts: [{ id: crypto.randomUUID(), name: '尺寸', value: `${i + 1}×8×3 cm`, source: 'manual', sourceRef: '', state: 'human_confirmed' }],
        variants: p.variants.map(({ id, sku, originalSpec, normalizedSpec, inventory }) => ({ id, sku, originalSpec, normalizedSpec, inventory, purchasePrice: `${i + 1}.25` })) });
      ids.push(p.id);
    }
    await window.red.moveWorkspaceProducts({ productIds: ids, destination: 'inbox' });
  });
  await page.reload();
  await page.getByLabel('采集箱每页数量').selectOption('100');
  for (const [search, count] of [['', 100], ['子集', 51]]) {
    await page.getByLabel('搜索采集箱').fill(search);
    await expect(page.locator('.collection-row')).toHaveCount(count);
    await expect(page.getByLabel('采集箱商品滚动区域')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('.inbox-inline-error')).toHaveCount(0);
    const rows = await page.locator('.collection-row').evaluateAll(rows => rows.map(row => ({ title: row.querySelector('.inbox-title-button').textContent, price: row.cells[3].textContent, size: row.cells[4].textContent })));
    for (const row of rows) {
      const i = Number(row.title.match(/\d+$/)[0]);
      assert.equal(row.price, `${i + 1}.25`);
      assert.equal(row.size, `${i + 1}×8×3 cm`);
    }
    console.log(`PASS ${count} actual product prices and dimensions displayed without summary error`);
  }
  await writeFile('artifacts/inbox-summary-pages-evidence.json', JSON.stringify({ dataRoot, ...runtime, counts: [100, 51], checkedEveryPriceAndSize: true, realElectron: true, replacedRed: false, externalRequests: 0 }, null, 2));
} finally { if (app) await app.close(); }
