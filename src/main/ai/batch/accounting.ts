import type { DatabaseSync } from 'node:sqlite';
import { readBatch,readItem } from './records.ts';

/** Batch-level fees and per-item fees are alternative views, never additive charges. */
export function batchAccounting(db:DatabaseSync,id:string){
  const batch=readBatch(db,id),items=batch.itemIds.map(key=>readItem(db,key));
  const itemReportedCostUsd=items.reduce((sum,item)=>sum+(item.reportedCostUsd??0),0);
  const unknownItemCosts=items.filter(item=>item.reportedCostUsd===null).length;
  return {id,calls:items.length,reportedBatchCostUsd:batch.reportedCostUsd,itemReportedCostUsd,unknownItemCosts,
    totalCostUsd:batch.reportedCostUsd??(unknownItemCosts===0?itemReportedCostUsd:null),
    basis:batch.reportedCostUsd!==null?'batch_actual' as const:unknownItemCosts===0?'items_actual' as const:'unknown' as const,
    // Allocation stays unknown unless the provider actually supplied every item cost.
    allocationComplete:unknownItemCosts===0};
}
