import { expect } from '@playwright/test';

// Electron sends resize notifications asynchronously on Windows. Validate the
// renderer only after its viewport agrees with the settled native content size.
export async function resizeWindow(app, page, width, height) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
  await expect.poll(async () => {
    const native = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return { outer: window.getSize(), content: window.getContentSize() };
    });
    const viewport = await page.evaluate(() => [innerWidth, innerHeight]);
    return native.outer[0] === width && native.outer[1] === height && native.content.every((value, index) => value === viewport[index]);
  }, { timeout: 10000 }).toBe(true);
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
}
