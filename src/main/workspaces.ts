import type { DatabaseSync } from 'node:sqlite';
import type { MoveWorkspaceProducts, WorkspaceLane, WorkspacePlacement } from '../shared/workspace-contracts.ts';
import { UserFacingError } from '../shared/errors.ts';
import { identifier, record } from '../shared/validation.ts';

export function parseMoveWorkspaceProducts(raw: unknown): MoveWorkspaceProducts {
  const input = record(raw, '工作区移动参数', ['productIds', 'destination']);
  if (!Array.isArray(input.productIds) || input.productIds.length < 1 || input.productIds.length > 500) {
    throw new UserFacingError('请选择 1 至 500 件商品，商品 ID 必须为数组');
  }
  const productIds = Array.from(input.productIds, identifier);
  if (new Set(productIds).size !== productIds.length) throw new UserFacingError('移动商品 ID 不能重复');
  if (typeof input.destination !== 'string' || !['inbox', 'manual', 'automatic', 'ignored'].includes(input.destination)) {
    throw new UserFacingError('目标工作区无效');
  }
  return { productIds, destination: input.destination as WorkspaceLane };
}

export function readWorkspacePlacements(db: DatabaseSync, productIds?: readonly string[]): WorkspacePlacement[] {
  if (productIds?.length === 0) return [];
  const filter = productIds ? `WHERE p.id IN (${productIds.map(() => '?').join(',')})` : '';
  return db.prepare(`SELECT p.id, COALESCE(w.lane, 'manual') AS lane, COALESCE(w.updated_at, p.updated_at) AS updated_at
    FROM products p LEFT JOIN product_workspaces w ON w.product_id=p.id ${filter}
    ORDER BY p.updated_at DESC,p.rowid DESC`).all(...productIds ?? []).map(row => ({
    productId: String(row.id), lane: row.lane as WorkspaceLane, updatedAt: String(row.updated_at),
  }));
}
