import { UserFacingError } from '../shared/errors.ts';
import type { ProductDetail } from '../shared/contracts.ts';
import type { ImportedProduct } from './store.ts';
import { randomUUID } from 'node:crypto';
import { parseSaveProduct, record } from '../shared/validation.ts';

function csvRows(contents: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false, closed = false;
  for (let i = 0; i < contents.length; i++) {
    const ch = contents[i];
    if (quoted) {
      if (ch === '"') { if (contents[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else cell += ch;
    } else if (ch === '"') {
      if (cell || closed) throw new UserFacingError('CSV 引号格式不正确'); quoted = true;
    } else if (ch === ',' || ch === '\n' || ch === '\r') {
      row.push(cell); cell = ''; closed = false;
      if (ch !== ',') {
        if (row.some(value => value.trim())) rows.push(row); row = [];
        if (ch === '\r' && contents[i + 1] === '\n') i++;
      }
    } else {
      if (closed) { if (ch.trim()) throw new UserFacingError('CSV 引号结束后有无效字符'); } else cell += ch;
    }
  }
  if (quoted) throw new UserFacingError('CSV 有未闭合的引号');
  row.push(cell); if (row.some(value => value.trim())) rows.push(row);
  return rows;
}
function fromCsv(contents: string): unknown[] {
  const rows = csvRows(contents); if (rows.length < 2) throw new UserFacingError('CSV 需要表头和至少一行商品数据');
  const headers = rows[0].map(h => h.trim());
  const allowed = ['productKey', 'title', 'sourceUrl', 'description', 'sku', 'originalSpec', 'normalizedSpec', 'purchasePrice', 'inventory'];
  if (new Set(headers).size !== headers.length || headers.some(h => !allowed.includes(h))) throw new UserFacingError('CSV 含有重复或不支持的列，请使用导入模板');
  if (['productKey', 'title', 'sku'].some(name => !headers.includes(name))) throw new UserFacingError('CSV 缺少 productKey、title 或 sku 列');
  const groups = new Map<string, Record<string, unknown>>();
  rows.slice(1).forEach((cells, index) => {
    if (cells.length !== headers.length) throw new UserFacingError(`CSV 第 ${index + 2} 行列数与表头不一致`);
    const values = Object.fromEntries(headers.map((header, column) => [header, cells[column].trim()]));
    if (!values.productKey) throw new UserFacingError(`CSV 第 ${index + 2} 行缺少商品编号 productKey`);
    let product = groups.get(values.productKey);
    if (!product) {
      product = { title: values.title, sourceUrl: values.sourceUrl || '', description: values.description || '', status: 'draft', variants: [], facts: [] };
      groups.set(values.productKey, product);
    } else if (product.title !== values.title || product.sourceUrl !== (values.sourceUrl || '') || product.description !== (values.description || '')) throw new UserFacingError(`CSV 商品 ${values.productKey} 的标题、链接或备注不一致`);
    (product.variants as unknown[]).push({ sku: values.sku, originalSpec: values.originalSpec || '', normalizedSpec: values.normalizedSpec || '',
      purchasePrice: values.purchasePrice || '', inventory: values.inventory ? (/^\d+$/.test(values.inventory) ? Number(values.inventory) : NaN) : null });
  });
  return [...groups.values()];
}
function normalizeProduct(raw: unknown): ImportedProduct {
  const p = record(raw, '导入商品', ['title', 'sourceUrl', 'description', 'status', 'variants', 'facts']);
  if (!Array.isArray(p.variants) || p.variants.length > 200) throw new UserFacingError('导入商品需要 variants 数组，每件最多 200 个 SKU');
  if (p.facts !== undefined && !Array.isArray(p.facts)) throw new UserFacingError('facts 必须为数组');
  const variants = p.variants.map(rawVariant => {
    const v = record(rawVariant, '导入 SKU', ['sku', 'originalSpec', 'normalizedSpec', 'purchasePrice', 'inventory']);
    return { id: randomUUID(), sku: v.sku, originalSpec: v.originalSpec ?? '', normalizedSpec: v.normalizedSpec ?? '', purchasePrice: v.purchasePrice ?? '', inventory: v.inventory ?? null };
  });
  const facts = ((p.facts as unknown[]) || []).map(rawFact => {
    const f = record(rawFact, '导入事实', ['name', 'value', 'source', 'sourceRef', 'state', 'scope', 'variantSku']);
    const {variantSku,...fact}=f;
    const variant=f.scope==='variant'?variants.find(v=>v.sku===variantSku):undefined;
    if(f.scope==='variant'&&!variant||f.scope!=='variant'&&variantSku!==undefined)throw new UserFacingError('导入事实的适用 SKU 无效');
    return { ...fact, ...(variant?{variantId:variant.id}:{}), id: randomUUID(), source: f.source ?? 'import', sourceRef: f.sourceRef ?? '', state: f.state ?? 'source_confirmed' };
  });
  const { id: _id, revision: _revision, ...result } = parseSaveProduct({ id: randomUUID(), revision: 1, title: p.title, sourceUrl: p.sourceUrl ?? '', description: p.description ?? '',
    status: p.status ?? 'draft', variants, facts });
  return result;
}
export function parseImport(contents: string, format: string): ImportedProduct[] {
  if (Buffer.byteLength(contents, 'utf8') > 5 * 1024 * 1024) throw new UserFacingError('导入文件不能超过 5 MB');
  const clean = contents.replace(/^\uFEFF/, ''); let raw: unknown[];
  if (format === 'csv') raw = fromCsv(clean);
  else if (format === 'json') {
    let parsed: unknown; try { parsed = JSON.parse(clean); } catch { throw new UserFacingError('JSON 格式不正确，请检查文件'); }
    const document = record(parsed, 'JSON 导入文件', ['format', 'version', 'products']);
    if (document.format !== 'red-product-data' || (document.version !== 1 && document.version !== 2) || !Array.isArray(document.products)) throw new UserFacingError('导入文件格式或版本不支持，请使用 HTC 商品资料格式 v1 或 v2');
    raw = document.products;
  } else throw new UserFacingError('仅支持 JSON 或 CSV 商品资料文件');
  if (!raw.length || raw.length > 100) throw new UserFacingError('每次导入 1 至 100 件商品');
  const products = raw.map(normalizeProduct), skus = products.flatMap(p => p.variants.map(v => v.sku.toLowerCase()));
  if (new Set(skus).size !== skus.length) throw new UserFacingError('导入文件中的 SKU 不能重复');
  return products;
}
export function exportProductData(product: ProductDetail): unknown {
  return { format: 'red-product-data', version: product.facts.some(f=>f.scope!==undefined)?2:1, products: [{ title: product.title, sourceUrl: product.sourceUrl, description: product.description, status: product.status,
    variants: product.variants.map(({ sku, originalSpec, normalizedSpec, purchasePrice, inventory }) => ({ sku, originalSpec, normalizedSpec, purchasePrice, inventory })),
    facts: product.facts.map(({ name, value, source, sourceRef, state, scope, variantId }) => ({ name, value, source, sourceRef, state, ...(scope?{scope}:{}), ...(scope==='variant'?{variantSku:product.variants.find(v=>v.id===variantId)?.sku}:{}) })),
  }] };
}
