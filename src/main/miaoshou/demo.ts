import { fail } from './validation.ts';

const image = (product: string, file: string) => `https://demo.invalid/miaoshou/${product}/${file}.png`;
// Deliberately use the public envelope and field names so demos pass through the live parser.
const FIXTURES = [
  { commonCollectBoxDetailId: 'demo-single', title: '【演示】桌面收纳托盘 · 单 SKU', itemNum: 'DEMO-TRAY', notesText: '虚构演示资料，用于体验公共采集箱导入。材质、尺寸及价格均需要真实来源确认。', notes: '', sourceAttrs: [], price: '6.50', stock: 42,
    imgUrls: [image('demo-single', 'main'), image('demo-single', 'detail')], colorMap: {}, sizeMap: {}, saleProp3Map: {}, skuMap: { 'tray-one': { itemNum: 'DEMO-TRAY-1', price: '6.50', oriPrice: '5.80', stock: 42, weight: '0.15', packageLength: '20', packageWidth: '12', packageHeight: '3' } }, sourceList: [], sourceMataInfo: {}, sourceSupplierInfo: {} },
  { commonCollectBoxDetailId: 'demo-colors', title: '【演示】旅行收纳袋 · 颜色与尺寸', itemNum: 'DEMO-BAG', notesText: '虚构的多规格商品。请分别选择各 SKU 对应的颜色与尺寸，不根据来源键的顺序猜测。', notes: '', sourceAttrs: [], imgUrls: [image('demo-colors', 'main')],
    colorPropName: '颜色', sizePropName: '尺寸', colorMap: { 'tone-b': { name: '深蓝', imgUrls: [image('demo-colors', 'navy')] }, 'tone-a': { name: '米白', imgUrl: image('demo-colors', 'cream') } }, sizeMap: { 'fit-b': { name: '大号' }, 'fit-a': { name: '小号' } }, saleProp3Map: {},
    skuMap: { 'bag-04': { itemNum: 'DEMO-BAG-04', price: '8.20', oriPrice: '7.00', stock: 24 }, 'bag-01': { itemNum: 'DEMO-BAG-01', price: '6.20', oriPrice: '5.10', stock: 31 }, 'bag-03': { itemNum: 'DEMO-BAG-03', price: '8.20', oriPrice: '7.00', stock: 17 }, 'bag-02': { itemNum: 'DEMO-BAG-02', price: '6.20', oriPrice: '5.10', stock: 22 } }, sourceList: [], sourceMataInfo: {}, sourceSupplierInfo: {} },
  { commonCollectBoxDetailId: 'demo-pack', title: '【演示】理线夹 · 多件装与第三规格', itemNum: 'DEMO-CLIP', notesText: '虚构的多件装商品。第三规格候选仅作为来源选项展示，实际包装数量需要核实。高精度价格会完整留在来源快照。', notes: '', sourceAttrs: [], imgUrls: [image('demo-pack', 'main')],
    colorPropName: '颜色', sizePropName: '夹口', saleProp3Name: '包装', colorMap: { 'tone-neutral': { name: '灰色', imgUrl: image('demo-pack', 'gray') } }, sizeMap: { 'opening-standard': { name: '标准' } }, saleProp3Map: { 'pack-three': { name: '3 件装' }, 'pack-six': { name: '6 件装' } },
    skuMap: { 'clip-bundle-x': { itemNum: 'DEMO-CLIP-X', price: '2.123456', oriPrice: '1.90', stock: 60, oriStock: 80 }, 'clip-bundle-y': { itemNum: 'DEMO-CLIP-Y', price: '3.90', oriPrice: '3.10', stock: null, oriStock: null } }, sourceList: [], sourceMataInfo: {}, sourceSupplierInfo: {} },
];
export function demoDetail(id: string): unknown { const detail = FIXTURES.find(p => p.commonCollectBoxDetailId === id); if (!detail) return fail('INPUT'); return structuredClone({ result: 'success', code: 'success', data: { editCommonCollectBoxDetail: detail } }); }
export function demoList(pageNo: number, pageSize: number): unknown {
  const rows = FIXTURES.map(p => ({ commonCollectBoxDetailId: p.commonCollectBoxDetailId, title: p.title, sourceList: p.sourceList, status: '演示', gmtModified: '', minSkuPrice: null, maxSkuPrice: null }));
  return { result: 'success', code: 'success', data: { detailList: rows.slice((pageNo - 1) * pageSize, pageNo * pageSize), total: rows.length } };
}
