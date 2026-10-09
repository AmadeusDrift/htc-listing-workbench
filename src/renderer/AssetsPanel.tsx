import { Check, ImageIcon, Images, Link2, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Asset, AssetRole, ProductDetail } from '../shared/contracts';
import { formatBytes } from './utils';

interface Props {
  product: ProductDetail;
  busy: boolean;
  onImport: () => void;
  onUpdate: (assetId: string, role: AssetRole, variantIds: string[]) => void;
}

const roleLabels: Record<AssetRole, string> = { main: '商品主图', gallery: '商品辅图', detail: '详情图片' };

export function AssetsPanel({ product, busy, onImport, onUpdate }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(product.assets[0]?.id ?? null);
  const [preview, setPreview] = useState<Asset | null>(null);
  const selected = product.assets.find((asset) => asset.id === selectedId) ?? product.assets[0];

  useEffect(() => { setSelectedId(product.assets[0]?.id ?? null); setPreview(null); }, [product.id]);
  useEffect(() => {
    if (!preview) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setPreview(null); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [preview]);

  return <div className="assets-panel">
    <div className="section-heading"><div><h3>商品图片 <span className="quiet-count">{product.assets.length}</span></h3><p>管理图片用途，并关联到一个或多个 SKU。</p></div>
      <button type="button" className="button primary" disabled={busy} onClick={onImport}><Plus size={16} />导入图片</button>
    </div>
    <div className="info-strip"><ImageIcon size={16} /><span>支持 PNG / JPG，每张不超过 20 MB，每次最多 20 张。每件商品只保留一张主图，图片设置会直接保存。</span></div>
    {product.assets.length === 0 ? <div className="asset-empty"><div className="empty-icon"><Images size={34} strokeWidth={1.25} /></div><h3>为商品添加第一张图片</h3><p>从本机选择 PNG / JPG 图片，设置主图、辅图或详情用途。<br />同一张图片可以关联多个 SKU。</p><button type="button" className="button secondary" disabled={busy} onClick={onImport}><Plus size={16} />选择本地图片</button></div>
      : <div className="asset-workspace"><div className="asset-grid" aria-label="商品图片列表">
        {product.assets.map((asset) => <button type="button" className={`asset-card ${selected?.id === asset.id ? 'selected' : ''}`} key={asset.id} onClick={() => setSelectedId(asset.id)} aria-pressed={selected?.id === asset.id}>
          <span className="asset-image"><img src={asset.previewUrl} alt={asset.fileName} /><span className={`asset-role ${asset.role}`}>{roleLabels[asset.role]}</span>{selected?.id === asset.id && <span className="asset-selected-mark"><Check size={13} /></span>}</span>
          <span className="asset-file-name" title={asset.fileName}>{asset.fileName}</span>
          <span className="asset-dimensions">{asset.width} × {asset.height} px <span>{formatBytes(asset.byteSize)}</span></span>
          <span className="asset-sku-pills">{asset.variantIds.length ? asset.variantIds.map((id) => <span className="sku-pill" key={id}>{product.variants.find((variant) => variant.id === id)?.sku || '未命名 SKU'}</span>) : <span className="unlinked-label">尚未关联 SKU</span>}</span>
        </button>)}
      </div>
      {selected && <aside className="asset-inspector" aria-label="图片设置"><div className="inspector-heading"><h4>图片设置</h4><span>自动保存</span></div>
        <button type="button" className="inspector-preview" aria-label={`查看大图 ${selected.fileName}`} onClick={() => setPreview(selected)}><img src={selected.previewUrl} alt={selected.fileName} /><span>查看大图</span></button>
        <p className="inspector-file-name">{selected.fileName}</p><p className="muted small-copy">{selected.width} × {selected.height} px · {formatBytes(selected.byteSize)}</p>
        <label className="field-label" htmlFor="image-role">图片用途</label><select id="image-role" value={selected.role} disabled={busy} onChange={(event) => onUpdate(selected.id, event.target.value as AssetRole, selected.variantIds)}>
          <option value="main">商品主图</option><option value="gallery">商品辅图</option><option value="detail">详情图片</option>
        </select>
        <div className="association-heading"><h4><Link2 size={14} />关联 SKU</h4><span>{selected.variantIds.length} 个</span></div>
        {product.variants.length === 0 ? <p className="small-copy muted">先在「SKU 与规格」添加 SKU，再建立图片关联。</p> : <div className="sku-checkboxes">{product.variants.map((variant, index) => <label className="sku-checkbox" key={variant.id}>
          <input type="checkbox" disabled={busy} checked={selected.variantIds.includes(variant.id)} aria-label={`关联 SKU ${variant.sku || index + 1}`} onChange={(event) => {
            const ids = event.target.checked ? [...selected.variantIds, variant.id] : selected.variantIds.filter((id) => id !== variant.id);
            onUpdate(selected.id, selected.role, ids);
          }} /><span><strong className="mono">{variant.sku || `未命名 SKU ${index + 1}`}</strong><small>{variant.normalizedSpec || variant.originalSpec || '未填写规格'}</small></span>
        </label>)}</div>}
        <p className="association-note">取消勾选只解除 SKU 关联，图片仍保留在商品中。</p>
      </aside>}
    </div>}
    {preview && <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="图片预览" onClick={() => setPreview(null)} onKeyDown={(event) => { if (event.key === 'Tab') { event.preventDefault(); event.currentTarget.querySelector('button')?.focus(); } }}><button type="button" className="lightbox-close icon-button" aria-label="关闭图片预览" onClick={() => setPreview(null)} autoFocus><X size={22} /></button><img src={preview.previewUrl} alt={preview.fileName} onClick={(event) => event.stopPropagation()} /><p>{preview.fileName} · {preview.width} × {preview.height} px</p></div>}
  </div>;
}
