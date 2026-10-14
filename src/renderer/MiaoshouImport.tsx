import { PageSizeSelect, useListPageSize } from './ListPagination';
import { useEffect, useState } from 'react';
import { ArrowDownToLine, ChevronLeft, ChevronRight, RefreshCw, X } from 'lucide-react';
import type { MiaoshouDimensionId, MiaoshouList, MiaoshouMapping, MiaoshouPreview, MiaoshouStatus } from '../shared/miaoshou-contracts';
import { errorText } from './utils';
import { resolveMiaoshouSpecifications } from '../shared/miaoshou-measurements';
import { MiaoshouMeasurements } from './MiaoshouMeasurements';
import { MiaoshouSync } from './MiaoshouSync';

interface Prepared { preview: MiaoshouPreview; mapping: MiaoshouMapping; result?: string; failed?: boolean }
function initialMapping(preview: MiaoshouPreview): MiaoshouMapping {
  return { priceField: 'none', currency: 'unknown', skus: preview.product.skus.map(sku => ({ sourceKey: sku.key,
    dimensions: Object.fromEntries(resolveMiaoshouSpecifications(preview.product, sku.key).map(row => [row.dimension.id, row.value.id])) })) };
}
export function MiaoshouImport({ onClose, onChanged }: { onClose: () => void; onChanged: () => Promise<unknown> }) {
  const [pageSize, setPageSize] = useListPageSize('miaoshou-import');
  const [status, setStatus] = useState<MiaoshouStatus | null>(null), [list, setList] = useState<MiaoshouList | null>(null);
  const [selected, setSelected] = useState<string[]>([]), [prepared, setPrepared] = useState<Prepared[]>([]), [focus, setFocus] = useState(0);
  const [working, setWorking] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  useEffect(() => { let active = true; void window.red.getMiaoshouStatus().then(value => { if (active) setStatus(value); }, cause => { if (active) setError(errorText(cause)); }); return () => { active = false; }; }, []);
  async function task(operation: () => Promise<void>) {
    if (working) return; setWorking(true); setError(''); setNotice('');
    try { await operation(); } catch (cause) { setError(errorText(cause)); } finally { setWorking(false); }
  }
  async function load(pageNo = 1, size = pageSize) {
    const result = await window.red.listMiaoshouProducts({ pageNo, pageSize: size });
    setList(result);
  }
  async function switchMode(mode: 'demo' | 'live') {
    setStatus(await window.red.setMiaoshouMode(mode));
    setList(null); setSelected([]); setPrepared([]); setFocus(0);
    await load();
  }
  async function previewSelection() {
    const next: Prepared[] = []; const failed: string[] = [];
    for (const id of selected) {
      try { const preview = await window.red.previewMiaoshouProduct({ id }); next.push({ preview, mapping: initialMapping(preview) }); }
      catch (cause) { failed.push(`${id}：${errorText(cause)}`); }
    }
    setPrepared(next); setFocus(0); if (failed.length) setError(failed.join('；'));
  }
  function changeMapping(change: (mapping: MiaoshouMapping) => MiaoshouMapping) {
    setPrepared(current => current.map((row, index) => index === focus ? { ...row, mapping: change(row.mapping), result: undefined, failed: undefined } : row));
  }
  function selectDimension(sourceKey: string, dimension: MiaoshouDimensionId, value: string) {
    changeMapping(mapping => ({ ...mapping, skus: mapping.skus.map(sku => {
      if (sku.sourceKey !== sourceKey) return sku;
      const dimensions = { ...sku.dimensions }; if (value) dimensions[dimension] = value; else delete dimensions[dimension];
      return { ...sku, dimensions };
    }) }));
  }
  async function importPrepared() {
    const next = [...prepared]; let added = 0, duplicates = 0, failures = 0;
    for (let index = 0; index < next.length; index++) {
      const row = next[index];
      try {
        const result = await window.red.importMiaoshouProduct({ previewId: row.preview.previewId, mapping: row.mapping });
        if (result.duplicate) duplicates++; else added++;
        next[index] = { ...row, failed: false, result: `${result.duplicate ? '已存在，未重复创建' : '已导入采集箱'} · ${result.skuCount} SKU${result.warnings.length ? ` · ${result.warnings.join('；')}` : ''}` };
      } catch (cause) { failures++; next[index] = { ...row, failed: true, result: errorText(cause) }; }
      setPrepared([...next]);
    }
    await onChanged(); setNotice(`新增 ${added} 件，已存在 ${duplicates} 件，失败 ${failures} 件。图片可在商品来源预览中下载。`);
  }
  const active = prepared[focus], product = active?.preview.product;
  return <section className="miaoshou-import" aria-label="妙手导入面板" aria-busy={working}>
    <header className="section-heading"><div><h2>从妙手导入</h2><p>读取公共采集箱，核对规格和采购价后加入工作台。</p></div><button className="icon-button" aria-label="关闭妙手导入" disabled={working} onClick={onClose}><X size={19} /></button></header>
    <div className="workflow-actions"><span className={`quiet-pill ${status?.mode === 'demo' ? 'attention' : ''}`}>{status?.mode === 'demo' ? '演示数据 · 不访问妙手' : status?.mode === 'live' ? '妙手真实接口' : '尚未配置'}</span>
      <button className="button secondary" disabled={working} onClick={() => void task(() => switchMode('demo'))}>使用妙手演示数据</button>
      {status?.configured && status.mode !== 'live' && <button className="button secondary" disabled={working} onClick={() => void task(() => switchMode('live'))}>切换到真实采集箱</button>}
      <button className="button primary" disabled={working || !status || status.mode === 'unconfigured'} onClick={() => void task(() => load(list?.pageNo ?? 1))}><RefreshCw size={15} />读取妙手采集箱</button>
    </div>
    {status?.mode === 'unconfigured' && <p className="settings-help">可以先使用演示数据。真实连接请在设置中保存配置模板，填写后导入。</p>}
    {status && status.mode !== 'unconfigured' && <MiaoshouSync key={`${status.mode}:${status.appKeyHint}`} disabled={working} onPreview={preview => { setPrepared([{ preview, mapping: initialMapping(preview) }]); setFocus(0); setNotice('已从暂存区打开预览，请在下方核对规格和采购价。'); }} />}
    {working && <p role="status">正在处理妙手商品…</p>}{error && <p className="miaoshou-error" role="alert">{error}</p>}{notice && <p className="workflow-notice" role="status">{notice}</p>}
    {list && <>
      <div className="miaoshou-list-heading"><label className="check-label"><input type="checkbox" aria-label="选择本页妙手商品" disabled={working || !list.items.length} checked={list.items.length > 0 && list.items.every(item => selected.includes(item.id))} onChange={event => setSelected(ids => event.target.checked ? [...new Set([...ids, ...list.items.map(item => item.id)])] : ids.filter(id => !list.items.some(item => item.id === id)))} />本页商品</label><span>共 {list.total} 件 · 第 {list.pageNo} 页</span></div>
      <div className="miaoshou-product-list">{list.items.map(item => <label className="miaoshou-product-row" key={item.id}><input type="checkbox" aria-label={`选择妙手商品 ${item.title}`} disabled={working} checked={selected.includes(item.id)} onChange={event => setSelected(ids => event.target.checked ? [...new Set([...ids, item.id])] : ids.filter(id => id !== item.id))} /><span><strong>{item.title || '未命名商品'}</strong><small>{item.sourceName || '来源待核对'} · 编号 {item.id}</small></span><span className="miaoshou-price">来源价 {item.minPrice ?? '—'}{item.maxPrice && item.maxPrice !== item.minPrice ? ` – ${item.maxPrice}` : ''}<small>币种与口径待确认</small></span></label>)}</div>
      {!list.items.length && <p>采集箱中还没有可读取的商品。先用妙手现有工具采集，再刷新列表。</p>}
      <div className="workflow-actions"><PageSizeSelect label="妙手商品每页数量" disabled={working} value={pageSize} onChange={value => { setPageSize(value); void task(() => load(1, value)); }}/><button className="button secondary" disabled={working || list.pageNo <= 1} onClick={() => void task(() => load(list.pageNo - 1))}><ChevronLeft size={15} />上一页</button><button className="button secondary" disabled={working || list.pageNo * list.pageSize >= list.total} onClick={() => void task(() => load(list.pageNo + 1))}>下一页<ChevronRight size={15} /></button><button className="button primary" disabled={working || !selected.length} onClick={() => void task(previewSelection)}>预览所选商品（{selected.length}）</button></div>
    </>}
    {active && product && <section className="miaoshou-preview" aria-label="妙手字段映射">
      <div className="workflow-actions">{prepared.map((row, index) => <button className={`button ${index === focus ? 'primary' : 'secondary'}`} key={row.preview.previewId} disabled={working} onClick={() => setFocus(index)}>{index + 1}. {row.preview.product.title.slice(0, 24)}{row.result ? row.failed ? ' · 失败' : ' · 已处理' : ''}</button>)}</div>
      <h3>{product.title || '未命名商品'}</h3><p className="settings-help">{product.skus.length} 个 SKU · {product.images.length} 条图片链接 · {product.attributes.length} 条来源属性。预览有效期 15 分钟。</p>
      {active.preview.existingProductId && <p className="workflow-notice">此来源商品已导入。这里展示最新暂存版本；再次导入会保留已有商品、人工修改和原始导入记录，不会重复创建。</p>}
      {product.warnings.length > 0 && <details><summary>查看采集时的来源提示（{product.warnings.length}）</summary><ul className="settings-help">{product.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      <div className="miaoshou-mapping-options"><label>采购价取值<select aria-label="妙手采购价取值" disabled={working} value={active.mapping.priceField} onChange={event => changeMapping(mapping => ({ ...mapping, priceField: event.target.value as MiaoshouMapping['priceField'] }))}><option value="none">暂不填写采购价</option><option value="price">使用 price 字段</option><option value="oriPrice">使用 oriPrice 字段</option></select></label><label>采购价币种<select aria-label="妙手采购价币种" disabled={working || active.mapping.priceField === 'none'} value={active.mapping.currency} onChange={event => changeMapping(mapping => ({ ...mapping, currency: event.target.value as MiaoshouMapping['currency'] }))}><option value="unknown">尚未确认</option><option value="CNY">已确认是人民币 CNY</option></select></label></div>
      <p className="settings-help">选择价格字段并确认人民币后才写入采购价；供货库存不会写入本地可售库存。能按来源 SKU 唯一对应的规格已自动选择，仍可修改；无法对应的保留待核对。</p>
      <div className="miaoshou-sku-table"><table><thead><tr><th>来源 SKU</th><th>price / oriPrice</th>{product.dimensions.map(dimension => <th key={dimension.id}>{dimension.name}</th>)}</tr></thead><tbody>{product.skus.map(sku => <tr key={sku.key}><td><strong>{sku.itemNum || sku.key}</strong>{sku.itemNum && <small>{sku.key}</small>}</td><td>{sku.price ?? '—'} / {sku.oriPrice ?? '—'}</td>{product.dimensions.map(dimension => <td key={dimension.id}><select aria-label={`${sku.key} ${dimension.name}`} disabled={working} value={active.mapping.skus.find(row => row.sourceKey === sku.key)?.dimensions[dimension.id] ?? ''} onChange={event => selectDimension(sku.key, dimension.id, event.target.value)}><option value="">待核对</option>{dimension.values.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></td>)}</tr>)}</tbody></table></div>
      <MiaoshouMeasurements key={product.remoteId} product={product} mapping={active.mapping} />
      <details><summary>查看来源属性和文字</summary><dl className="miaoshou-facts">{product.attributes.map((attribute, index) => <div key={index}><dt>{attribute.name}</dt><dd>{attribute.value}</dd></div>)}</dl><p className="miaoshou-description">{product.description || '无来源描述'}</p>{product.detailText && <p className="miaoshou-description">{product.detailText}</p>}{product.sources.map((source, index) => <p className="path-value" key={index}>{source.sourceItemUrl || `${source.source} ${source.sourceItemId}`}</p>)}</details>
      {active.result && <p role={active.failed ? 'alert' : 'status'} className="workflow-notice">{active.result}</p>}
      <button className="button primary" disabled={working} onClick={() => void task(importPrepared)}><ArrowDownToLine size={16} />导入已预览商品（{prepared.length}）</button>
    </section>}
  </section>;
}
