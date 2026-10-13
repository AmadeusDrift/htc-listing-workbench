import { SourceAdoptionPanel } from './SourceAdoptionPanel';
import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, ImageIcon, LoaderCircle, X } from 'lucide-react';
import type { ProductDetail } from '../shared/contracts';
import type { MiaoshouProduct, MiaoshouReceipt } from '../shared/miaoshou-contracts';
import type { WorkspaceLane } from '../shared/workspace-contracts';
import { analyzeMiaoshouMeasurements, MEASUREMENT_LABELS, resolveMiaoshouSpecifications } from '../shared/miaoshou-measurements';
import type { MeasurementField } from '../shared/miaoshou-measurements';
import { automaticMiaoshouMapping } from '../shared/inbox-summary';
import { errorText, formatDate, sourceLabel } from './utils';
import { InboxDialog } from './InboxDialog';
import { InboxSourceImage } from './InboxSourceImage';
import { CollectionSource } from './CollectionSource';

interface Props { productId: string; hasSourceUpdate?: boolean; busy: boolean; onClose: () => void; onChanged:()=>Promise<unknown>; onMove: (ids: string[], lane: WorkspaceLane, open?: boolean) => void }
const measurementFields: MeasurementField[] = ['item.length', 'item.width', 'item.height', 'item.diameter', 'item.weight', 'package.length', 'package.width', 'package.height', 'package.weight'];
const galleryPageSize = 8;

export function InboxProductDetail({ productId, hasSourceUpdate, busy, onClose, onMove, onChanged }: Props) {
  const [product, setProduct] = useState<ProductDetail | null>(null), [receipt, setReceipt] = useState<MiaoshouReceipt | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [sourceError, setSourceError] = useState(''), [reload, setReload] = useState(0);
  const [skuKey, setSkuKey] = useState(''), [imageIndex, setImageIndex] = useState(0), [galleryPage, setGalleryPage] = useState(0);
  const [latestRequested, setLatestRequested] = useState(false), [latest, setLatest] = useState<MiaoshouProduct | null>(null);
  const [latestState, setLatestState] = useState<'idle' | 'loading' | 'loaded' | 'empty' | 'failed'>('idle'), [latestError, setLatestError] = useState(''), [latestRetry, setLatestRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setSourceError('');
    void Promise.allSettled([window.red.getProduct(productId), window.red.getMiaoshouReceipt(productId)]).then(([detail, source]) => {
      if (!active) return;
      if (detail.status === 'fulfilled') setProduct(detail.value); else setError(errorText(detail.reason));
      if (source.status === 'fulfilled') setReceipt(source.value); else setSourceError(errorText(source.reason));
      setSkuKey(source.status === 'fulfilled' && source.value ? source.value.snapshot.skus[0]?.key ?? '' : detail.status === 'fulfilled' ? detail.value.variants[0]?.id ?? '' : '');
      setLoading(false);
    });
    return () => { active = false; };
  }, [productId, reload]);
  useEffect(() => {
    if (!latestRequested) return;
    let active = true;
    setLatestState('loading'); setLatestError('');
    void window.red.getMiaoshouSourceUpdate(productId).then(value => {
      if (!active) return;
      setLatest(value); setLatestState(value ? 'loaded' : 'empty');
      setSkuKey(value?.skus[0]?.key ?? receipt?.snapshot.skus[0]?.key ?? '');
      setImageIndex(0); setGalleryPage(0);
    }, cause => { if (active) { setLatestError(errorText(cause)); setLatestState('failed'); } });
    return () => { active = false; };
  }, [productId, latestRequested, latestRetry, receipt]);
  const showingLatest = latestRequested && latestState === 'loaded' && latest !== null;
  const source = showingLatest ? latest : receipt?.snapshot;
  const sourceMapping = useMemo(() => showingLatest && latest ? automaticMiaoshouMapping(latest) : receipt?.mapping, [showingLatest, latest, receipt]);
  const measurements = useMemo(() => source ? analyzeMiaoshouMeasurements(source, sourceMapping) : null, [source, sourceMapping]);
  const imageVersion = showingLatest ? 'latest' : 'imported';
  const displayTitle = showingLatest ? source?.title || '未命名商品' : product?.title || '商品详情';
  const displaySourceUrl = showingLatest ? source?.sources[0]?.sourceItemUrl : product?.sourceUrl;
  const description = showingLatest ? source?.detailText || source?.description : source?.detailText || product?.description;
  const images = useMemo(() => [
    ...(source?.images.map(image => ({ key: `${imageVersion}-${image.id}`, imageId: image.id, localUrl: null as string | null, label: image.role === 'main' ? '来源主图' : image.role === 'detail' ? '来源详情图' : '来源商品图' })) ?? []),
    ...(!showingLatest ? product?.assets.map(asset => ({ key: `local-${asset.id}`, imageId: null as string | null, localUrl: asset.previewUrl, label: asset.fileName || '本地图片' })) ?? [] : []),
  ], [source, imageVersion, showingLatest, product]);
  const selectedImage = images[imageIndex] ?? images[0];
  const selectedSku = source?.skus.find(sku => sku.key === skuKey) ?? source?.skus[0];
  const localVariantId = showingLatest ? undefined : receipt?.skuMappings.find(row => row.sourceKey === selectedSku?.key)?.localVariantId;
  const localVariant = showingLatest ? undefined : product?.variants.find(variant => variant.id === (localVariantId ?? skuKey)) ?? product?.variants[0];
  const skuMeasurements = measurements?.skus.find(row => row.sourceKey === selectedSku?.key);
  const specification = skuMeasurements?.specification || localVariant?.sourceSpec || localVariant?.originalSpec;
  const price = selectedSku ? (sourceMapping?.priceField === 'oriPrice' ? selectedSku.oriPrice ?? selectedSku.price : selectedSku.price ?? selectedSku.oriPrice) : localVariant?.sourcePurchasePrice || localVariant?.purchasePrice;
  const selectSku = (key: string) => {
    setSkuKey(key);
    const relatedUrls = showingLatest && source ? resolveMiaoshouSpecifications(source, key, sourceMapping).flatMap(row => row.value.imageUrls) : [];
    const imageId = showingLatest ? source?.images.find(image => relatedUrls.includes(image.url))?.id : receipt?.skuMappings.find(row => row.sourceKey === key)?.imageIds[0];
    const index = imageId ? images.findIndex(image => image.imageId === imageId) : -1;
    if (index >= 0) { setImageIndex(index); setGalleryPage(Math.floor(index / galleryPageSize)); }
  };
  const selectImage = (index: number) => { setImageIndex(index); setGalleryPage(Math.floor(index / galleryPageSize)); };
  const returnToImported = () => { setLatestRequested(false); setSkuKey(receipt?.snapshot.skus[0]?.key ?? product?.variants[0]?.id ?? ''); setImageIndex(0); setGalleryPage(0); };
  return <InboxDialog label="商品详情" className="inbox-product-dialog" onClose={onClose}>
    <header className="inbox-dialog-header"><div><span className="section-kicker">{showingLatest ? '来源新版本 · 只读' : '商品资料'}</span><h2>{displayTitle}</h2></div><button type="button" className="icon-button" aria-label="关闭商品详情" onClick={onClose}><X size={20} /></button></header>
    <div className="inbox-dialog-body inbox-product-body">
      {loading ? <div className="inbox-detail-loading" role="status"><LoaderCircle className="spin" size={23} /><span>正在读取商品资料…</span></div> : error ? <div className="inbox-detail-loading" role="alert"><p>{error}</p><button type="button" className="button secondary" onClick={() => setReload(value => value + 1)}>重试读取商品</button></div> : product && <>
        {sourceError && <div className="inbox-inline-error" role="alert"><span>来源资料读取失败：{sourceError}</span><button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>重试读取来源</button></div>}
        {product&&<SourceAdoptionPanel product={product} busy={busy} onAdopted={value=>{setProduct(value);returnToImported();void window.red.getMiaoshouReceipt(productId).then(setReceipt).catch(cause=>setSourceError(errorText(cause)));void onChanged();}}/>}
        {(hasSourceUpdate || latestRequested) && <div className="inbox-source-update"><div><p role="status">{latestRequested && latestState === 'loading' ? '正在读取来源新版本…' : showingLatest ? '当前展示最近同步的来源新版本，仅供查看，入箱资料未改变。' : latestRequested && latestState === 'empty' ? '暂未找到可用的新版本，当前仍展示入箱资料。' : latestRequested && latestState === 'failed' ? '新版本读取失败，当前仍展示入箱资料。' : '来源有更新，当前展示入箱时保留的资料。'}</p>{latestRequested && latestState === 'failed' && <p role="alert">{latestError}</p>}</div><div className="inbox-source-version-actions">{latestRequested && (latestState === 'empty' || latestState === 'failed') && <button type="button" className="text-button" onClick={() => { setLatestState('loading'); setLatestRetry(value => value + 1); }}>重试读取新版本</button>}<button type="button" className="button secondary" onClick={() => { if (latestRequested) returnToImported(); else { setLatestState('loading'); setLatestRequested(true); } }}>{latestRequested ? '返回入箱资料' : '查看来源新版本'}</button></div></div>}
        {latestRequested && latestState === 'loading' ? <div className="inbox-detail-loading" role="status"><LoaderCircle className="spin" size={23} /><span>正在读取来源新版本…</span></div> : <div className="inbox-detail-grid">
          <section className="inbox-gallery" aria-label="商品图集">
            {selectedImage ? <InboxSourceImage key={selectedImage.key} productId={productId} imageId={selectedImage.imageId} localUrl={selectedImage.localUrl} version={imageVersion} alt={`${displayTitle} · ${selectedImage.label}`} className="inbox-gallery-hero" /> : <div className="inbox-gallery-empty"><ImageIcon size={44} strokeWidth={1.2} /><span>这件商品还没有图片</span></div>}
            {images.length > 0 && <><div className="inbox-gallery-caption"><span>{selectedImage?.label}</span><div><button type="button" className="icon-button" aria-label="上一张商品图片" disabled={imageIndex <= 0} onClick={() => selectImage(imageIndex - 1)}><ChevronLeft size={16} /></button><span>{imageIndex + 1} / {images.length}</span><button type="button" className="icon-button" aria-label="下一张商品图片" disabled={imageIndex >= images.length - 1} onClick={() => selectImage(imageIndex + 1)}><ChevronRight size={16} /></button></div></div><div className="inbox-gallery-thumbnails">{images.slice(galleryPage * galleryPageSize, (galleryPage + 1) * galleryPageSize).map((image, offset) => {
              const index = galleryPage * galleryPageSize + offset;
              return <div className={`inbox-gallery-thumb ${index === imageIndex ? 'active' : ''}`} key={image.key}><InboxSourceImage productId={productId} imageId={image.imageId} localUrl={image.localUrl} version={imageVersion} alt={`商品图片 ${index + 1}`} openLabel={`查看第 ${index + 1} 张商品图片`} onOpen={() => setImageIndex(index)} /></div>;
            })}</div>{images.length > galleryPageSize && <nav className="inbox-gallery-pages" aria-label="商品图集分页"><button type="button" className="text-button" disabled={galleryPage <= 0} onClick={() => setGalleryPage(value => value - 1)}>前一组图片</button><span>{galleryPage + 1} / {Math.ceil(images.length / galleryPageSize)}</span><button type="button" className="text-button" disabled={(galleryPage + 1) * galleryPageSize >= images.length} onClick={() => setGalleryPage(value => value + 1)}>后一组图片</button></nav>}</>}
            <div className="inbox-detail-source"><span>{showingLatest ? '妙手来源新版本' : receipt ? '妙手来源' : sourceLabel(product.sourceUrl)}</span><p>{displaySourceUrl || '尚未填写来源链接'}</p>{receipt && <small>{showingLatest && source ? `${formatDate(source.capturedAt)} 来源快照 · 编号 ${source.remoteId}` : `${formatDate(receipt.receivedAt)} 入箱 · 编号 ${receipt.snapshot.remoteId}`}</small>}</div>
          </section>
          <div className="inbox-detail-parameters">
            <section aria-label="SKU 与参数"><div className="inbox-detail-section-title"><h3>SKU 与参数</h3><span>{source?.skus.length ?? product.variants.length} 个 SKU</span></div>
              <label className="field inbox-sku-picker"><span>查看 SKU 参数</span><select aria-label="查看 SKU 参数" value={skuKey} disabled={!(source ? source.skus.length : product.variants.length)} onChange={event => selectSku(event.target.value)}>{source ? source.skus.map(sku => <option key={sku.key} value={sku.key}>{measurements?.skus.find(row => row.sourceKey === sku.key)?.specification || sku.itemNum || sku.key}</option>) : product.variants.map(variant => <option key={variant.id} value={variant.id}>{variant.sourceSpec || variant.originalSpec || variant.sku || '未命名 SKU'}</option>)}</select></label>
              <dl className="inbox-sku-overview"><div><dt>来源价格</dt><dd>{price || '—'}</dd></div><div><dt>供货库存</dt><dd>{selectedSku?.stock ?? localVariant?.inventory ?? '—'}</dd></div><div><dt>SKU 编号</dt><dd>{selectedSku?.itemNum || localVariant?.sku || '—'}</dd></div><div><dt>规格</dt><dd>{specification || '—'}</dd></div></dl>
              {source && <><h4 className="inbox-measurement-heading">尺寸与重量</h4><dl className="inbox-measurement-grid">{measurementFields.map(field => {
                const value = skuMeasurements?.values[field];
                return <div key={field}><dt>{MEASUREMENT_LABELS[field]}</dt><dd>{value ? `${value.sourceValue} ${value.sourceUnit}` : '—'}</dd></div>;
              })}<div><dt>来源重量</dt><dd>{selectedSku?.weight ? `${selectedSku.weight} kg` : '—'}{selectedSku?.weight && <small>净毛重未说明</small>}</dd></div></dl>
                {!!skuMeasurements?.evidence.length && <details className="inbox-measurement-evidence"><summary>查看尺寸重量原值与采用依据</summary><div className="inbox-evidence-rows">{skuMeasurements.evidence.map((evidence, index) => <div key={index}><strong>{MEASUREMENT_LABELS[evidence.field]}</strong><span>{evidence.sourceValue} {evidence.sourceUnit || '（无单位）'}</span><small>{evidence.reason}</small><p>{evidence.evidence}</p></div>)}</div></details>}</>}
            </section>
            <section aria-label="全部商品属性"><div className="inbox-detail-section-title"><h3>全部属性</h3><span>{source?.attributes.length ?? product.facts.length} 项</span></div><dl className="inbox-all-attributes">{(source ? source.attributes : product.facts).map((attribute, index) => <div key={`${attribute.name}-${index}`}><dt>{attribute.name || '未命名属性'}</dt><dd>{attribute.value || '—'}</dd></div>)}</dl>{!(source?.attributes.length ?? product.facts.length) && <p className="inbox-muted">暂无已记录的属性。</p>}</section>
            {!showingLatest && !receipt && <CollectionSource productId={productId} />}
            {!showingLatest && receipt && product.facts.some(fact => fact.source === 'manual') && <section aria-label="本地补充资料"><div className="inbox-detail-section-title"><h3>本地补充资料</h3></div><dl className="inbox-all-attributes">{product.facts.filter(fact => fact.source === 'manual').map(fact => <div key={fact.id}><dt>{fact.name}</dt><dd>{fact.value || '—'}</dd></div>)}</dl></section>}
            {description && <section aria-label="商品说明"><div className="inbox-detail-section-title"><h3>商品说明</h3></div><p className="inbox-detail-description">{description}</p></section>}
          </div>
        </div>}
      </>}
    </div>
    <footer className="inbox-dialog-footer"><span className="inbox-muted">{latestRequested ? '来源新版本仅供查看，入箱资料未改变' : '来源资料保留在商品档案中'}</span><div><button type="button" className="button secondary" onClick={onClose}>返回列表</button>{!latestRequested && <button type="button" className="button primary" disabled={busy || loading || !product} onClick={() => { onMove([productId], 'manual', true); onClose(); }}>加入手动并打开<ArrowRight size={16} /></button>}</div></footer>
  </InboxDialog>;
}
