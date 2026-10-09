import type { DatabaseSync } from 'node:sqlite';
import type { ConfirmedMeasurements, MeasurementSet } from '../amazon/field-mapping.ts';
import { getReceipt } from './persistence.ts';
import { analyzeMiaoshouMeasurements } from '../../shared/miaoshou-measurements.ts';

/** Use the persisted source/local SKU binding; never infer it from the local SKU name. */
export function miaoshouMeasurementsForVariant(db: DatabaseSync, productId: string, variantId: string, targetMode: 'live' | 'demo'): ConfirmedMeasurements {
  const receipt = getReceipt(db, productId);
  if (!receipt || targetMode === 'live' && receipt.mode === 'demo') return {};
  const sourceKey = receipt.skuMappings.find(row => row.localVariantId === variantId)?.sourceKey;
  if (!sourceKey) return {};
  const row = analyzeMiaoshouMeasurements(receipt.snapshot, receipt.mapping).skus.find(row => row.sourceKey === sourceKey);
  const result: ConfirmedMeasurements = {};
  for (const scope of ['item', 'package'] as const) {
    const group: MeasurementSet = {};
    for (const axis of ['length', 'width', 'height', 'weight'] as const) {
      const value = row?.values[`${scope}.${axis}`];
      if (value?.value !== null && value?.value !== undefined) group[axis] = { value: value.value, unit: value.unit };
    }
    if (Object.keys(group).length) result[scope] = group;
  }
  return result;
}
