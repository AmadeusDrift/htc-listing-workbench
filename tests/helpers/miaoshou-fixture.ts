import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { SecretStorage } from '../../src/main/amazon/vault.ts';
import type { MiaoshouMapping, MiaoshouProduct } from '../../src/shared/miaoshou-contracts.ts';
import type { MiaoshouRateClock } from '../../src/main/miaoshou/rate-limit.ts';

export function testMiaoshouClock(): MiaoshouRateClock {
  let elapsed = 0;
  return { now: () => elapsed, sleep: async (ms, signal) => { if (signal.aborted) throw signal.reason; elapsed += ms; } };
}

/** The real OS boundary is injected; the file still contains authenticated ciphertext in tests. */
export function testMiaoshouStorage(): SecretStorage {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]); },
    decryptString(value) { const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(-16)); return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString('utf8'); },
  };
}

export function detailFixture() {
  return { result: 'success', code: 'success', data: { editCommonCollectBoxDetail: {
    commonCollectBoxDetailId: '90071992547409931', title: '三维收纳袋', itemNum: 'SUPPLIER-ITEM',
    notesText: '', notes: '<p>商品说明 &amp; 尺寸</p><script>secret script</script><p>以来源为准</p>',
    sourceAttrs: [{ name: '材质', value: '棉布' }], price: '9.876543', stock: 19,
    imgUrls: ['https://images.example.com/main.jpg'],
    colorPropName: '颜色', sizePropName: '尺寸', saleProp3Name: '包装',
    colorMap: { opaqueBlue: { name: '蓝色', imgUrls: ['https://images.example.com/blue.jpg'] }, opaqueRed: { name: '红色', imgUrl: 'https://images.example.com/red.jpg' } },
    sizeMap: { medium: { name: 'M' }, small: { name: 'S' } },
    saleProp3Map: { triple: { name: '3 件装' }, single: { name: '1 件装' } },
    skuMap: {
      arbitraryB: { itemNum: 'B', price: '9.876543', oriPrice: '8.90', stock: 19, oriStock: 20, weight: '0.012345', packageLength: 12, packageHeight: 2 },
      arbitraryA: { itemNum: 'A', price: 0, oriPrice: null, stock: null, oriStock: 0, packageWidth: '5.50' },
    },
    sourceList: [{ sourceItemId: '123456', source: '1688', sourceSite: '1688.com', sourceItemUrl: 'https://detail.1688.com/offer/123456.html' }],
    sourceMataInfo: { account: 'MUST_NOT_STORE' }, sourceSupplierInfo: { token: 'MUST_NOT_STORE' }, unknown: { secret: 'MUST_NOT_STORE' },
  } } };
}
export function listFixture() {
  return { result: 'success', code: 'success', data: { detailList: [{ commonCollectBoxDetailId: '90071992547409931', title: '三维收纳袋', minSkuPrice: '0', maxSkuPrice: '9.876543', gmtModified: '2026-10-06 10:00:00', status: 'NORMAL', sourceList: detailFixture().data.editCommonCollectBoxDetail.sourceList, appAccountId: 'MUST_NOT_STORE' }], total: 1 } };
}
export function mappingFor(product: MiaoshouProduct, selected = false): MiaoshouMapping {
  return { priceField: 'none', currency: 'unknown', skus: product.skus.map(sku => ({ sourceKey: sku.key, dimensions: selected ? { color: 'opaqueBlue', size: 'medium', third: 'triple' } : {} })) };
}
