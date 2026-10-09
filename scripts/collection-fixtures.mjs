/** Synthetic supplier-like structures, not copied real 1688 pages. */
export function collectionFixture(name) {
  const offerId = name === 'single' ? '123456701' : name === 'partial' ? '123456702' : '123456703';
  const row = (id, color, price, image) => ({ skuId: id, specAttrs: [{ propName: '颜色', valueName: color }], price, ...(image ? { imageUrl: `https://cbu01.alicdn.com/local-fixture/${image}.jpg` } : {}) });
  let skuInfoMap = name === 'single' ? { first: row('single-sku', '白色', '12.3400', 'white') } : { blue: row('sku-blue', '蓝色', '0.123456789012', 'blue'), white: row('sku-white', '白色', '15.20', 'white') };
  if (name === 'partial') skuInfoMap = { unknown: { spec: 'structure not recognized' } };
  if (name === 'over-limit') skuInfoMap = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [i, row(`sku-${i}`, `色-${i}`, '1.00')]));
  if (name === 'ambiguous') skuInfoMap.white.skuId = 'sku-blue';
  const model = { offerTitleModel: { subject: name === 'changed' ? '本地样例 · 收纳盒（新资料）' : `本地样例 · ${name === 'single' ? '单规格' : name === 'partial' ? '缺项' : '多规格'}收纳盒` },
    tradeModel: { offerId, offerPriceModel: { currentPrices: [{ beginAmount: '2', price: '12.3400' }, { beginAmount: '10', price: '11.20' }] }, priceDisplay: '11.20-12.3400' }, skuModel: { skuInfoMap } };
  const context = { result: { global: { globalData: { model } }, data: { gallery: { fields: { mainImage: 'https://cbu01.alicdn.com/local-fixture/main.jpg', offerImgList: [] } } } } };
  if (name === 'partial') { model.offerTitleModel.subject = ''; model.tradeModel.offerPriceModel.currentPrices = []; model.tradeModel.priceDisplay = ''; context.result.data.gallery.fields.mainImage = ''; }
  if (name === 'image-array') context.result.data.gallery.fields.mainImage = ['https://cbu01.alicdn.com/local-fixture/main-a.jpg', 'https://cbu01.alicdn.com/local-fixture/main-b.jpg'];
  const serialized = JSON.stringify(context).replaceAll('<', '\\u003c');
  const detail = name === 'detail-shadow' ? '<div class="html-description"><img data-src="https://cbu01.alicdn.com/local-fixture/detail-a.jpg"><v-detail-e></v-detail-e></div><img data-src="https://cbu01.alicdn.com/local-fixture/unrelated-ad.jpg">' : '';
  const shadow = name === 'detail-shadow' ? 'const host=document.querySelector("v-detail-e");const child=document.createElement("img");child.setAttribute("data-lazyload-src","https://cbu01.alicdn.com/local-fixture/detail-b.jpg");host.attachShadow({mode:"open"}).append(child);' : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="htc-fixture-source" content="https://detail.1688.com/offer/${offerId}.html"><title>HTC 本地采集测试样例</title></head><body><h1>${model.offerTitleModel.subject}</h1><p>本机合成资料，不连接 1688。</p>${detail}${name === 'challenge' ? '<input type="password" aria-label="模拟登录状态">' : ''}<script>window.context=${serialized};${shadow}</script></body></html>`;
}
