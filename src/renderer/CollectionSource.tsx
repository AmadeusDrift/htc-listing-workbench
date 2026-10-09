import { useEffect, useState } from 'react';
import type { CollectionReceipt } from '../shared/collection-contracts';
import { warningLabels } from '../shared/collection-labels';
import { formatDate } from './utils';
export function CollectionSource({ productId }: { productId: string }) {
  const [receipt, setReceipt] = useState<CollectionReceipt | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false; setReceipt(null); setError(false);
    void window.red.getCollectionReceipt(productId).then(value => { if (!cancelled) setReceipt(value); }, () => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [productId]);
  if (error) return <p role="alert">采集来源暂时未能读取，请关闭预览后重试。</p>;
  if (!receipt) return null;
  const source = receipt.snapshot;
  return <section className="collection-source-record" aria-label="采集来源快照">
    <h3>采集来源快照</h3><p className="inspector-note">{formatDate(receipt.receivedAt)} 入箱 · {source.skus.length} 个来源 SKU · {source.images.length} 条图片链接</p>
    {source.warnings.length > 0 && <ul className="settings-help">{source.warnings.map(code => <li key={code}>{warningLabels[code]}</li>)}</ul>}
    <details><summary>查看来源价格与图片对应</summary>
      <p className="inspector-note">来源价格均为采购价，币种 CNY。图片链接尚未下载为本地素材。</p>
      {source.pricing.unitPrice !== null && <p>单价：{source.pricing.unitPrice}</p>}
      {source.pricing.range && <p>区间：{source.pricing.range.min} – {source.pricing.range.max}</p>}
      {source.pricing.tiers.map(tier => <p key={tier.minQuantity}>起订 {tier.minQuantity} 件：{tier.unitPrice}</p>)}
      <div className="source-sku-list">{source.skus.map(sku => <div key={sku.providerSkuId}><strong>{sku.providerSkuId}</strong><span>{sku.originalSpec || '规格待补'}</span><span>来源采购价 {sku.purchasePrice ?? '未读取'}</span><span>{source.skuImages.filter(m => m.providerSkuId === sku.providerSkuId).length} 条已对应图片</span></div>)}</div>
      <ul className="collection-source-urls">{source.images.map(item => <li key={item.id}><span>{item.id} · {item.role}</span><span>{item.url}</span></li>)}</ul>
    </details>
  </section>;
}
