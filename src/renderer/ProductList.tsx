import { Box, ChevronRight, ImageIcon, Search, SearchX, SlidersHorizontal, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ProductStatus, ProductSummary } from '../shared/contracts';
import { formatDate, sourceLabel, statusLabels } from './utils';

interface Props {
  products: ProductSummary[];
  selectedId?: string;
  busy: boolean;
  onSelect: (id: string) => void;
}

export function ProductList({ products, selectedId, busy, onSelect }: Props) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ProductStatus | 'all'>('all');
  const filtered = useMemo(() => products.filter((product) =>
    (status === 'all' || product.status === status) &&
    `${product.title} ${product.sourceUrl}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  ), [products, search, status]);

  return <aside className="product-index" aria-label="商品列表">
    <div className="index-heading"><h2>商品列表</h2><span className="count-label">{products.length} 件</span></div>
    <div className="index-tools">
      <div className="search-field"><Search size={16} aria-hidden="true" />
        <input aria-label="搜索商品" placeholder="搜索商品标题或来源" value={search} onChange={(event) => setSearch(event.target.value)} />
        {search && <button className="icon-button small" type="button" aria-label="清除搜索" onClick={() => setSearch('')}><X size={14} /></button>}
      </div>
      <div className="index-filter"><SlidersHorizontal size={14} aria-hidden="true" />
        <select aria-label="筛选商品状态" value={status} onChange={(event) => setStatus(event.target.value as ProductStatus | 'all')}>
          <option value="all">全部状态</option><option value="draft">草稿</option><option value="ready">已就绪</option><option value="archived">已归档</option>
        </select><span>{filtered.length} 件商品</span>
      </div>
    </div>
    <div className="product-items">
      {filtered.map((product) => <button type="button" key={product.id} data-testid={`product-${product.id}`}
        className={`product-item ${selectedId === product.id ? 'selected' : ''}`} aria-pressed={selectedId === product.id}
        disabled={busy} onClick={() => onSelect(product.id)}>
        <span className="product-thumb">{product.coverUrl ? <img src={product.coverUrl} alt="" /> : <Box size={25} strokeWidth={1.35} />}</span>
        <span className="product-item-body">
          <span className="product-item-title">{product.title || '未命名商品'}</span>
          <span className="product-item-sub">{sourceLabel(product.sourceUrl)}{product.origin === 'sample' && <span className="sample-tag">示例</span>}</span>
          <span className="product-item-metadata"><span className={`status-text ${product.status}`}><span />{statusLabels[product.status]}</span><span>{product.variantCount} SKU</span><span><ImageIcon size={11} />{product.assetCount}</span></span>
        </span>
        <ChevronRight className="product-item-arrow" size={14} aria-hidden="true" />
        <span className="product-item-time">{formatDate(product.updatedAt, true)}</span>
      </button>)}
      {filtered.length === 0 && <div className="filter-empty"><SearchX size={30} strokeWidth={1.3} /><strong>没有匹配的商品</strong><p>试试其他关键词或商品状态。</p><button type="button" className="text-button" onClick={() => { setSearch(''); setStatus('all'); }}>清除筛选</button></div>}
    </div>
    <div className="index-footer"><span className="live-dot" />资料保存在本机</div>
  </aside>;
}
