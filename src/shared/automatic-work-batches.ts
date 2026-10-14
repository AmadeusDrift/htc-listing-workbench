/** A local working set. This identity is separate from remote AI and procurement batches. */
export interface AutomaticWorkBatch {
  id:string; name:string; date:string|null; sequence:number; createdAt:string|null;
  archivedAt:string|null; productIds:string[]; taskIds:string[];
}
