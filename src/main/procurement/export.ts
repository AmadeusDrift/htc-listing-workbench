import type { ProcurementBatch } from '../../shared/procurement-contracts.ts';
import type { ItemLabelStatus } from '../../shared/item-label-contracts.ts';
import { salesPurchaseDescription } from '../../shared/sales-purchase.ts';

const labelStatus: Record<ItemLabelStatus,string> = { NOT_REQUESTED:'未获取',WAITING_SKU:'等待 SKU 就绪',WAITING_QUANTITY:'等待数量',QUEUED:'已排队',REQUESTING:'请求中',DOWNLOADING:'下载中',READY:'文件已就绪',STALE:'已过期',FAILED:'获取失败',CANCELLED:'已取消' };

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const csvCell = (value: unknown) => {
  let text = String(value ?? ''); if (/^[\s]*[=+@\-\t\r]/.test(text)) text = "'" + text;
  return `"${text.replaceAll('"', '""')}"`;
};
export function procurementCsv(batch: ProcurementBatch): string {
  const rows: unknown[][] = [['批次编号','环境','行号','备货行 ID','商品名称','规格','店铺','卖家 SKU','ASIN','FNSKU','1688 商品链接','来源商品 ID','来源 SKU','采购数量','采购单位','采购单价','币种','采购价已确认','备货数量（销售单位）','商品标签','已有货件号','货件验证','来源图片链接','销售组合采购明细']];
  batch.lines.forEach((line, index) => rows.push([batch.code,batch.mode === 'demo' ? '本地演示' : '正式',index+1,line.id,line.title,line.spec,line.targetName,line.sku,line.asin,line.fnsku,line.sourceUrl,line.sourceItemId,line.sourceSkuKey,
    line.purchaseQuantity,line.purchaseUnit,line.purchasePrice,line.currency === 'CNY' ? 'CNY' : '待确认',line.priceConfirmed ? '是' : '否',line.stockQuantity,labelStatus[line.labelStatus],batch.shipment?.confirmationId ?? '',batch.shipment ? '仅关联，未验证' : '',line.sourceImageUrl,line.salesRecipe&&line.stockQuantity!==null?salesPurchaseDescription(line.salesRecipe,line.stockQuantity):'']));
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
/** Only main-process verified, local PNG previews may be embedded. Source text is always escaped. */
export function procurementHtml(batch: ProcurementBatch, previews: Map<string, string>): string {
  const rows = batch.lines.map((line, i) => {
    const preview = line.imageAssetId ? previews.get(line.imageAssetId) : null;
    const image = preview && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(preview) ? `<img alt="商品图" src="${preview}">` : '<span>图片未下载</span>';
    return `<tr><td>${i+1}</td><td>${image}</td><td><strong>${escape(line.title)}</strong><br>${escape(line.spec)}<br>${line.salesRecipe && line.stockQuantity !== null ? `<small>${escape(salesPurchaseDescription(line.salesRecipe,line.stockQuantity))}</small>` : ''}${line.sourceUrl ? `<a href="${escape(line.sourceUrl)}" rel="noopener noreferrer">1688 / 来源商品</a><small>${escape(line.sourceUrl)}</small>` : '来源链接待补充'}</td><td>${escape(line.targetName)}<br>${escape(line.sku)}<small>ASIN：${escape(line.asin) || '待确认'}<br>FNSKU：${escape(line.fnsku) || '待获取'}</small></td><td>${line.purchaseQuantity ?? '待填'} ${escape(line.purchaseUnit)}</td><td>${escape(line.purchasePrice) || '待填'} ${line.currency === 'CNY' ? 'CNY' : '币种待确认'}<small>${line.priceConfirmed ? '已确认' : '价格待确认'}</small></td><td>${line.stockQuantity ?? '待填'}</td><td>${escape(labelStatus[line.labelStatus])}<small>${escape(line.id)}</small></td></tr>`;
  }).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(batch.name)} · 备货单</title><style>body{font:13px system-ui,sans-serif;color:#203447;padding:24px}h1{font-size:22px}p{color:#516577}table{width:100%;border-collapse:collapse}th,td{border:1px solid #cbd5df;padding:9px;text-align:left;vertical-align:top}th{background:#eef3f7}small{display:block;max-width:260px;overflow-wrap:anywhere;color:#607487;margin-top:5px}img{max-width:80px;max-height:80px}a{color:#125080}@media print{body{padding:0}thead{display:table-header-group}tr{break-inside:avoid}}</style><h1>${escape(batch.name)}${batch.mode === 'demo' ? '（本地演示）' : ''}</h1><p>批次 ${escape(batch.code)} · 修订 ${batch.revision} · ${batch.lines.length} 个 SKU</p><p>销售组合按备货套数展开采购明细；备货数量按 Amazon 销售单位计。商品标签以已保存并核验的 PDF 文件为准；不可将本表中的文字标识代替平台标签。</p><p>Send to Amazon 货件：${escape(batch.shipment?.confirmationId) || '未关联'}${batch.shipment ? '（仅关联，未验证或创建货件）' : ''}</p><table><thead><tr><th>行号</th><th>图片</th><th>商品与采购链接</th><th>店铺 / SKU</th><th>采购数量</th><th>采购价</th><th>备货数量</th><th>商品标签 / 对应行</th></tr></thead><tbody>${rows}</tbody></table></html>`;
}
