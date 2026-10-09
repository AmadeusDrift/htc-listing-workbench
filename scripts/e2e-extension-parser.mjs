import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildExtension } from './build-extension.mjs';
import { collectionFixture } from './collection-fixtures.mjs';
import { COLLECTION_EXTENSION_ID } from '../src/shared/collection-identity.ts';

await mkdir(resolve('.test-data'), { recursive: true });
const root = await mkdtemp(resolve('.test-data/extension-parser-'));
const extension = await buildExtension({ destination: join(root, 'extension'), testHost: 'com.htc.workbench.collection.test_parser123456' });
const server = createServer((request, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(collectionFixture(new URL(request.url, 'http://local').pathname.slice(1))); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const context = await chromium.launchPersistentContext(join(root, 'browser'), { executablePath: resolve('.cache/playwright/chromium-1243/chrome-win64/chrome.exe'), headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
const checks = [], errors = [];
let passed = false;
try {
  await context.route('**/*', route => { const url = new URL(route.request().url()); return url.hostname === '127.0.0.1' || (url.protocol === 'chrome-extension:' && url.hostname === COLLECTION_EXTENSION_ID) ? route.continue() : route.abort(); });
  const fixture = await context.newPage(); let popup = await context.newPage();
  popup.on('pageerror', error => errors.push(error.message));
  await popup.goto(`chrome-extension://${COLLECTION_EXTENSION_ID}/popup.html`);
  await expect(popup.getByRole('button', { name: '读取当前商品', exact: true })).toBeEnabled();
  for (const name of ['single', 'multi', 'partial', 'challenge', 'over-limit', 'ambiguous', 'image-array', 'detail-shadow']) {
    await fixture.goto(`http://127.0.0.1:${server.address().port}/${name}`); await fixture.bringToFront();
    // The preview is opened in a test tab; clicking through JS keeps the source tab active,
    // equivalent to a real action popup that does not replace the browser's active tab.
    await popup.getByRole('button', { name: '读取当前商品', exact: true }).evaluate(button => button.click());
    await expect(popup.getByRole('button', { name: '读取当前商品', exact: true })).toBeEnabled();
    if (['challenge', 'over-limit', 'ambiguous'].includes(name)) await expect(popup.getByRole('alert')).toContainText(({ challenge: '需要登录或验证', 'over-limit': '超过 200', ambiguous: '歧义' })[name]);
    else {
      await expect(popup.getByLabel('商品预览')).toBeVisible();
      await expect(popup.locator('#skus-count')).toHaveText(name === 'single' ? '1' : name === 'partial' ? '0' : '2');
      if (name === 'multi') { await popup.locator('summary').click(); await expect(popup.locator('#skus')).toContainText('0.123456789012'); }
      if (name === 'partial') await expect(popup.locator('#warnings')).toContainText('规格结构尚未识别');
      if (name === 'image-array') {
        const state = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'state' }));
        assert.equal(state.pending.snapshot.images.filter(image => image.url.includes('/main-')).length, 2);
      }
      if (name === 'detail-shadow') {
        const state = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'state' }));
        assert.equal(state.pending.snapshot.images.filter(image => image.role === 'detail').length, 2);
        assert.equal(state.pending.snapshot.images.some(image => image.url.includes('unrelated-ad')), false);
      }
    }
    checks.push(name); console.log(`PASS real extension page extraction: ${name}`);
  }
  await fixture.goto(`http://127.0.0.1:${server.address().port}/single`); await fixture.bringToFront();
  await popup.locator('#read').evaluate(button => button.click()); await expect(popup.locator('#read')).toBeEnabled();
  const old = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'state' }));
  await fixture.goto(`http://127.0.0.1:${server.address().port}/multi`);
  await fixture.evaluate(() => { const original = window.context; Object.defineProperty(window, 'context', { get() { const end = Date.now() + 1800; while (Date.now() < end) {} return original; } }); });
  await fixture.bringToFront();
  await popup.evaluate(() => { void chrome.runtime.sendMessage({ type: 'read' }).catch(() => {}); });
  await expect.poll(() => popup.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'state' })).working)).toBe(true);
  await popup.close(); popup = await context.newPage(); await popup.goto(`chrome-extension://${COLLECTION_EXTENSION_ID}/popup.html`);
  await expect(popup.locator('#source')).toContainText('123456703');
  await expect(popup.locator('#send')).toBeEnabled();
  const stale = await popup.evaluate(captureId => chrome.runtime.sendMessage({ type: 'send', captureId }), old.pending.captureId);
  assert.deepEqual(stale, { ok: false, code: 'CAPTURE_CONFLICT' });
  checks.push('reopened popup refreshes pending read and stale preview cannot send a different capture');
  console.log('PASS reopened popup refreshes pending read and stale preview cannot send a different capture');
  await popup.getByRole('button', { name: '检查连接', exact: true }).click();
  await expect(popup.getByRole('alert')).toContainText('未连接工作台');
  checks.push('native host unavailable');
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  errors.push(error.message); throw error;
} finally {
  await writeFile(resolve('artifacts/extension-parser-e2e-report.json'), JSON.stringify({ passed, checks, errors, syntheticOnly: true, at: new Date().toISOString() }, null, 2));
  await context.close(); await new Promise(resolve => server.close(resolve));
}
