import type { ListingReadiness, ProductDetail } from '../shared/contracts.ts';
export function checkReadiness(product: ProductDetail): ListingReadiness {
  const missingSpecs = product.variants.filter(v => !v.originalSpec);
  const missingImages = product.variants.filter(v => !product.assets.some(a => a.variantIds.includes(v.id)));
  const unconfirmed = product.facts.filter(f => !f.value || !['source_confirmed', 'human_confirmed'].includes(f.state));
  return { productId: product.id, checkedAt: new Date().toISOString(), mode: 'local', amazonConnected: false,
    note: '这是本地资料完整性检查。尚未连接 Amazon，也未执行商品类型 Schema 校验、验证预览或正式提交。',
    checks: [
      { key: 'title', label: '商品标题', passed: !!product.title && product.title !== '未命名商品', detail: product.title === '未命名商品' ? '请填写能识别商品的标题' : '已填写商品标题' },
      { key: 'variants', label: 'SKU 与来源规格', passed: product.variants.length > 0 && missingSpecs.length === 0,
        detail: !product.variants.length ? '请至少添加一个 SKU' : missingSpecs.length ? `${missingSpecs.length} 个 SKU 缺少原始规格` : `${product.variants.length} 个 SKU 已记录来源规格` },
      { key: 'main-image', label: '商品主图', passed: product.assets.some(a => a.role === 'main'), detail: product.assets.some(a => a.role === 'main') ? '已设置主图，图片内容仍需人工核对' : '请导入图片并指定主图' },
      { key: 'variant-images', label: 'SKU 图片归属', passed: product.variants.length > 0 && missingImages.length === 0,
        detail: missingImages.length ? `${missingImages.length} 个 SKU 尚未关联图片` : product.variants.length ? '所有 SKU 已显式关联图片' : '请先添加 SKU' },
      { key: 'facts', label: '商品事实与来源', passed: product.facts.length > 0 && unconfirmed.length === 0,
        detail: !product.facts.length ? '请记录材质、尺寸、重量等已知事实' : unconfirmed.length ? `${unconfirmed.length} 项事实缺失、冲突或待确认` : '已填写的事实均有确认状态；具体必填项以 Amazon Schema 为准' },
    ],
  };
}
