import type { SalesListingPlan } from '../../shared/sales-plan-contracts.ts';
import { validateSalesPlan } from './records.ts';

export type SalesParentIdentity = Pick<SalesListingPlan, 'namingGroupId' | 'sourceGroupKey' | 'baseSku'>;

/** Naming identity of the actual parent; the sale's own allocation never changes. */
export function getSalesParentIdentity(plan: SalesListingPlan | null | undefined): SalesParentIdentity | null {
  if (!plan) return null;
  const sale = validateSalesPlan(plan);
  if (sale.parentage === 'NONE') return null;
  const binding = sale.familyBinding;
  return binding
    ? { namingGroupId: binding.parentNamingGroupId, sourceGroupKey: binding.parentSourceGroupKey, baseSku: binding.parentBaseSku }
    : { namingGroupId: sale.namingGroupId, sourceGroupKey: sale.sourceGroupKey, baseSku: sale.baseSku };
}

/** Useful for grouping both existing families and unresolved independent plans. */
export function getSalesFamilySourceGroupKey(plan: SalesListingPlan): string {
  const sale = validateSalesPlan(plan);
  return sale.familyBinding?.parentSourceGroupKey ?? sale.sourceGroupKey;
}

/** Callers must separately check seller, marketplace, product type and current evidence. */
export function isSameSalesFamily(left: SalesListingPlan | null | undefined, right: SalesListingPlan | null | undefined): boolean {
  const a = getSalesParentIdentity(left), b = getSalesParentIdentity(right);
  return !!a && !!b && a.namingGroupId === b.namingGroupId && a.sourceGroupKey === b.sourceGroupKey
    && a.baseSku === b.baseSku && left!.variationTheme === right!.variationTheme;
}
