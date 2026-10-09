/** Serialized into the MAIN world by scripting.executeScript. Keep all helpers inside. */
export function read1688Page(allowFixture = false): Record<string, unknown> {
  const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const bounded = (value: unknown, limit = 2000): unknown => typeof value === 'string' ? value.length <= limit ? value : '' : typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
  const context = obj((window as unknown as Record<string, unknown>).context), result = obj(context.result);
  const model = obj(obj(obj(result.global).globalData).model), trade = obj(model.tradeModel);
  const gallery = obj(obj(obj(result.data).gallery).fields), skuModel = obj(model.skuModel ?? trade.skuModel);
  let url = location.href;
  // This branch is reachable only in the separate test build with a loopback host permission.
  if (__HTC_TEST_FIXTURES__ && allowFixture && location.hostname === '127.0.0.1' && location.protocol === 'http:') url = document.querySelector('meta[name="htc-fixture-source"]')?.getAttribute('content') ?? '';
  const blocked = Boolean(document.querySelector('#nocaptcha, #baxia-dialog-content, iframe[src*="captcha"], input[type="password"]'));
  const rows = skuModel.skuInfoMap;
  let skus: unknown = null, tooLarge = false;
  if (rows && typeof rows === 'object') {
    const values = Object.values(rows).slice(0, 201);
    skus = values.map(value => {
      const row = obj(value);
      const attrs = Array.isArray(row.specAttrs) ? row.specAttrs.slice(0, 21).map(a => { const attr = obj(a); return { propName: bounded(attr.propName, 100), valueName: bounded(attr.valueName, 500) }; }) : bounded(row.specAttrs);
      return { skuId: bounded(row.skuId, 128), specAttrs: attrs, price: bounded(row.discountPrice ?? row.price ?? row.salePrice, 100), imageUrl: bounded(row.imageUrl) };
    });
  } else if (Object.keys(skuModel).length) skus = { unrecognized: true };
  const images: unknown[] = [];
  const push = (value: unknown) => { if (images.length > 200) { tooLarge = true; return; } const v = bounded(value); if (v) images.push(v); };
  if (Array.isArray(gallery.mainImage)) for (const image of gallery.mainImage.slice(0, 202)) push(image);
  else push(gallery.mainImage);
  if (Array.isArray(gallery.offerImgList)) for (const i of gallery.offerImgList.slice(0, 202)) push(typeof i === 'string' ? i : obj(i).fullPathImageURI ?? obj(i).imageUrl);
  if (Array.isArray(gallery.wlImageInfos)) for (const i of gallery.wlImageInfos.slice(0, 202)) push(obj(i).fullPathImageURI);
  const detailImages: unknown[] = [];
  // Read only explicit product-description containers, including their already-open shadow roots.
  // Do not scroll, fetch lazy resources, read scripts, or collect unrelated page images.
  const containers = '.de-description-detail, #detailContentContainer, .html-description, .desc-lazyload-container';
  let visited = 0;
  function scan(root: Document | Element | ShadowRoot, inside: boolean, depth: number) {
    if (depth > 64 || visited > 10000) { tooLarge = true; return; }
    for (const child of root.children) {
      if (++visited > 10000) { tooLarge = true; return; }
      const belongs = inside || child.matches(containers);
      if (belongs && child.tagName === 'IMG') {
        const value = child.getAttribute('data-lazyload-src') || child.getAttribute('data-src') || child.getAttribute('data-ks-lazyload') || child.getAttribute('src');
        if (value) { if (detailImages.length >= 200) { tooLarge = true; return; } detailImages.push(bounded(value)); }
      }
      if (child.shadowRoot) scan(child.shadowRoot, belongs, depth + 1);
      scan(child, belongs, depth + 1);
      if (tooLarge) return;
    }
  }
  scan(document, false, 0);
  const prices = obj(trade.offerPriceModel).currentPrices;
  return { url, blocked, tooLarge,
    offerId: bounded(trade.offerId, 20),
    title: bounded(obj(model.offerTitleModel).subject ?? document.querySelector('h1')?.textContent ?? document.querySelector('meta[property="og:title"]')?.getAttribute('content'), 500),
    skus, images, detailImages,
    prices: Array.isArray(prices) ? prices.slice(0, 51).map(p => { const row = obj(p); return { beginAmount: bounded(row.beginAmount, 10), price: bounded(row.price, 100) }; }) : [],
    priceDisplay: bounded(trade.priceDisplay, 100), unitPrice: bounded(obj(trade.offerPriceModel).price, 100),
  };
}
