import type { FactState, ProductDetail, ProductStatus, SaveProductInput } from '../shared/contracts';

export type EditorTab = 'info' | 'variants' | 'assets' | 'checks';
export type MainView = 'inbox' | 'manual' | 'automatic' | 'results' | 'product-data' | 'procurement' | 'shipping' | 'catalog' | 'audit' | 'settings';

export const statusLabels: Record<ProductStatus, string> = { draft: '草稿', ready: '已就绪', archived: '已归档' };
export const factStateLabels: Record<FactState, string> = {
  source_confirmed: '来源已确认', human_confirmed: '人工已确认', missing: '待补充',
  ai_suggested: 'AI 建议', conflicting: '存在冲突',
};

// Keep the IPC payload explicit. Source snapshots and assets are managed by the main process.
export function toSaveInput(product: ProductDetail): SaveProductInput {
  return {
    id: product.id, revision: product.revision, title: product.title,
    sourceUrl: product.sourceUrl, description: product.description, status: product.status,
    variants: product.variants.map(({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory }) =>
      ({ id, sku, originalSpec, normalizedSpec, purchasePrice, inventory })),
    facts: product.facts.map(({ id, name, value, source, sourceRef, state, scope, variantId }) =>
      ({ id, name, value, source, sourceRef, state, ...(scope?{scope}:{}), ...(variantId?{variantId}:{}) })),
  };
}

export function isChanged(current: ProductDetail | null, saved: ProductDetail | null): boolean {
  return Boolean(current && saved && JSON.stringify(toSaveInput(current)) !== JSON.stringify(toSaveInput(saved)));
}

export function formatDate(value: string, short = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', short
    ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
    : { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false },
  ).format(date);
}

export function sourceLabel(url: string): string {
  if (!url) return '未填写来源';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return '已填写来源'; }
}

export function formatBytes(size: number): string {
  return size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') || '操作未完成，请重试。';
}
