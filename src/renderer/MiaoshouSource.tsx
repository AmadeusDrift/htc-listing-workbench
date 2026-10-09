import { useEffect, useState } from 'react';
import type { ProductDetail } from '../shared/contracts';
import type { MiaoshouReceipt } from '../shared/miaoshou-contracts';
import { errorText, formatDate } from './utils';
import { MiaoshouMeasurements } from './MiaoshouMeasurements';

export function MiaoshouSource({ product, onChanged, busy }: { product: ProductDetail; onChanged: (product: ProductDetail) => Promise<void>; busy: boolean }) {
  const [receipt, setReceipt] = useState<MiaoshouReceipt | null>(null), [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]), [working, setWorking] = useState(false), [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true; setReceipt(null); setError(''); setNotice(''); setSelected([]);
    void window.red.getMiaoshouReceipt(product.id).then(value => { if (active) { setReceipt(value); setSelected(value?.snapshot.images.slice(0, 20).map(image => image.id) ?? []); } }, cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [product.id]);
  async function download() {
    if (working) return; setWorking(true); setError(''); setNotice('');
    try {
      const result = await window.red.downloadMiaoshouImages({ productId: product.id, revision: product.revision, imageIds: selected });
      await onChanged(result.product);
      setNotice(`新保存 ${result.downloaded} 张，已有 ${result.existing} 张，失败 ${result.failures.length} 张。`);
      if (result.failures.length) setError(result.failures.map(item => `${item.imageId}：${item.message}`).join('；'));
    } catch (cause) { setError(errorText(cause)); } finally { setWorking(false); }
  }
  if (!receipt) return error ? <p role="alert">{error}</p> : null;
  const source = receipt.snapshot;
  return <section className="collection-source-record" aria-label="妙手来源快照">
    <h3>妙手来源快照</h3><p className="inspector-note">{receipt.mode === 'demo' ? '演示商品 · ' : ''}{formatDate(receipt.receivedAt)} 入箱 · 公共采集箱编号 {source.remoteId}</p>
    <p className="settings-help">来源价格字段：{receipt.mapping.priceField === 'none' ? '尚未采用' : receipt.mapping.priceField}；币种：{receipt.mapping.currency === 'CNY' ? '已确认人民币' : '待确认'}。源数据与后续编辑分别保留。</p>
    <MiaoshouMeasurements key={source.remoteId} product={source} mapping={receipt.mapping} />
    <details><summary>查看来源 SKU 与图片对应</summary><div className="source-sku-list">{source.skus.map(sku => <div key={sku.key}><strong>{sku.itemNum || sku.key}</strong><span>price：{sku.price ?? '—'} / oriPrice：{sku.oriPrice ?? '—'}</span><span>供货库存：{sku.stock ?? '未知'}</span><span>重量原值：{sku.weight ?? '未知'} kg（净毛重未明）；包装长 × 宽 × 高：{sku.packageLength ?? '—'} × {sku.packageWidth ?? '—'} × {sku.packageHeight ?? '—'} cm</span><span>已明确对应 {receipt.skuMappings.find(row => row.sourceKey === sku.key)?.imageIds.length ?? 0} 张图片</span></div>)}</div></details>
    {source.images.length > 0 && <details open><summary>来源图片（{source.images.length}）</summary><p className="settings-help">每次选择最多 20 张下载到素材库。{receipt.mode === 'demo' ? '演示图片由本机生成。' : '链接不可访问时显示失败，可稍后重试。'}</p>
      <div className="miaoshou-image-options">{source.images.map(image => <label key={image.id}><input type="checkbox" aria-label={`下载来源图 ${image.id}`} checked={selected.includes(image.id)} disabled={busy || working || (!selected.includes(image.id) && selected.length >= 20)} onChange={event => setSelected(ids => event.target.checked ? [...ids, image.id] : ids.filter(id => id !== image.id))} /><span>{image.role === 'main' ? '主图' : image.role === 'detail' ? '详情图' : '商品图'} · {image.id}<small>{image.url}</small></span></label>)}</div>
      <button className="button secondary" disabled={busy || working || !selected.length} onClick={() => void download()}>{working ? '正在下载来源图片…' : `下载所选来源图片（${selected.length}）`}</button>
    </details>}
    {notice && <p role="status" className="workflow-notice">{notice}</p>}{error && <p role="alert" className="miaoshou-error">{error}</p>}
  </section>;
}
