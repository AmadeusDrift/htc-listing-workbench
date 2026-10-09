import type { DatabaseSync } from 'node:sqlite';
import type { AmazonService } from '../amazon/service.ts';
import type { CategoryLibrary, CategoryMatch } from '../../shared/catalog-contracts.ts';
import { record, text } from '../../shared/validation.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { openDatabase } from '../database.ts';
import { categoryKey, validateCategoryLibrary } from './records.ts';

type CatalogAmazon = Pick<AmazonService, 'getTarget' | 'fetchProductTypeLibrary'>;
export class CatalogService {
  private db: DatabaseSync;
  private amazon: CatalogAmazon;
  private pending = new Map<string, Promise<CategoryLibrary>>();
  private closed = false;
  constructor(directory: string, amazon: CatalogAmazon) { this.db = openDatabase(directory); this.amazon = amazon; }
  get busy(): boolean { return this.pending.size > 0; }
  private ensureOpen(): void { if (this.closed) throw new UserFacingError('类目服务已停止'); }
  get(targetId: string): CategoryLibrary | null {
    this.ensureOpen(); const target = this.amazon.getTarget(text(targetId, '店铺 ID', 100, true)), key = categoryKey({ ...target, targetId: target.id });
    const row = this.db.prepare('SELECT record_json FROM category_libraries WHERE id=?').get(key);
    return row ? validateCategoryLibrary(JSON.parse(String(row.record_json))) : null;
  }
  sync(targetId: string): Promise<CategoryLibrary> {
    this.ensureOpen(); const id = text(targetId, '店铺 ID', 100, true);
    if (this.pending.has(id)) return this.pending.get(id)!;
    const work = this.synchronize(id).finally(() => this.pending.delete(id)); this.pending.set(id, work); return work;
  }
  private async synchronize(targetId: string): Promise<CategoryLibrary> {
    const scope = { ...this.amazon.getTarget(targetId), targetId }, key = categoryKey(scope);
    const productTypes = await this.amazon.fetchProductTypeLibrary(targetId);
    this.ensureOpen();
    if (categoryKey({ ...this.amazon.getTarget(targetId), targetId }) !== key) throw new UserFacingError('店铺已变化，类目缓存未被替换');
    const library = validateCategoryLibrary({ id: key, targetId, sellerId: scope.sellerId, marketplaceId: scope.marketplaceId, locale: scope.locale, mode: scope.mode,
      kind: 'product-types-v1', fetchedAt: new Date().toISOString(), productTypes: [...productTypes].sort((a,b) => a.name.localeCompare(b.name)) });
    this.db.prepare('INSERT INTO category_libraries(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(key, JSON.stringify(library));
    return library;
  }
  search(raw: unknown): CategoryMatch[] {
    const input = record(raw, '本地类目搜索', ['targetId','query']), targetId = text(input.targetId, '店铺', 100, true), query = text(input.query, '关键词', 300).toLowerCase().trim();
    const library = this.get(targetId); if (!library) return [];
    const words = query.split(/[\s_-]+/).filter(Boolean);
    return library.productTypes.map(item => {
      const name = item.name.toLowerCase(), display = item.displayName.toLowerCase(), haystack = `${name.replaceAll('_',' ')} ${display}`;
      const score = !query ? 0 : name === query || display === query ? 100 : haystack.includes(query) ? 90 : Math.round(70 * words.filter(word => haystack.includes(word)).length / words.length);
      return { ...item, score, reason: !query ? '本地类型索引' : score === 100 ? '名称完全匹配' : score === 90 ? '名称包含关键词' : '部分关键词匹配' };
    }).filter(item => !query || item.score > 0).sort((a,b) => b.score-a.score || a.name.localeCompare(b.name)).slice(0,50);
  }
  async close(): Promise<void> { if (this.closed) return; this.closed = true; await Promise.allSettled([...this.pending.values()]); this.db.close(); }
}
