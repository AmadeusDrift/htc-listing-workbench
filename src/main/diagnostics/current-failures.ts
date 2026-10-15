import { sanitizeFailureReason } from '../../shared/automatic-resume.ts';
import type { RunFailureSummary } from '../../shared/run-report-contracts.ts';

type FailureRow = Record<string, unknown>;
/** Presentation of saved current rows only: no history recovery, request or write. */
export function summarizeCurrentFailures(rows: FailureRow[]): RunFailureSummary {
  const groups = new Map<string, { stage: string; kind: string; code: string; reason: string; products: Set<string>; salesItemCount: number }>();
  const products = new Set<string>(); let failedSalesItems = 0;
  for (const row of rows) {
    if (row.status !== 'FAILED' || typeof row.productId !== 'string') continue;
    const stage = typeof row.stage === 'string' && /^(PLAN|SOURCES|CLASSIFY|DRAFT|IMAGES|PARENT|EXECUTION|READBACK|LABELS|COMPLETE)$/.test(row.stage) ? row.stage : 'UNKNOWN';
    const kind = ['UNKNOWN','SYSTEM_REPAIR','NEEDS_INPUT','UNCLASSIFIED'].includes(String(row.kind)) ? String(row.kind) : 'UNCLASSIFIED';
    const code = typeof row.code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(row.code) ? row.code : 'UNCLASSIFIED_FAILURE';
    const reason = typeof row.reason === 'string' && row.reason.trim() ? sanitizeFailureReason(row.reason.replace(/\b(?:proxy-)?authorization\s*[:=]\s*Bearer\s+[^\s,;]+/gi, '[凭据已隐藏]')).replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, '[原记录]').replace(/\s+/g, ' ').slice(0, 500) : '历史未保存具体原因，请核对原记录';
    const key = JSON.stringify([stage, kind, code, reason]);
    const group = groups.get(key) ?? { stage, kind, code, reason, products: new Set<string>(), salesItemCount: 0 };
    group.products.add(row.productId); group.salesItemCount++; groups.set(key, group);
    products.add(row.productId); failedSalesItems++;
  }
  return { affectedProducts: products.size, failedSalesItems, groups: [...groups.values()].map(({ products, ...group }) => ({ ...group, productCount: products.size })).sort((a,b) => b.productCount - a.productCount || b.salesItemCount - a.salesItemCount || a.code.localeCompare(b.code) || a.reason.localeCompare(b.reason)) };
}

