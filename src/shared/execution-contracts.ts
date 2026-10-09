export type ExecutionStatus = 'CREATED' | 'QUEUED' | 'RUNNING' | 'PAUSED' | 'NEEDS_ATTENTION' | 'COMPLETED' | 'CANCELLED';
export type ExecutionConcurrency = 1 | 3 | 5;
export type StepName = 'upload' | 'images' | 'validate' | 'preview' | 'submit' | 'readback';
export interface ExecutionStep { name: StepName; status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED'; attempts: number; error: string | null }
export interface ExecutionItem {
  draftId: string; productId: string; productRevision: number; variantId: string; sku: string;
  targetId: string; targetName: string; sellerId: string; marketplaceId: string; mode: 'demo' | 'live'; targetStamp: string;
  schemaHash: string; attributesHash: string; intendedAttributesHash: string | null; draftRevision: number;
  assets: { id: string; sha256: string; role: 'main' | 'gallery' }[];
  uploads: { assetId: string; uploadId: string; publicUrl: string; sha256: string }[];
  steps: ExecutionStep[]; status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED'; listingState: string | null; submitStarted: boolean;
}
export interface ExecutionTask {
  id: string; revision: number; status: ExecutionStatus; concurrency: ExecutionConcurrency; profileId: string; profileGeneration: number; profileStamp: string;
  items: ExecutionItem[]; createdAt: string; updatedAt: string; error: string | null;
}
export interface CreateExecutionTaskInput { draftIds: string[]; profileId: string; concurrency?: ExecutionConcurrency }
export interface ExecutionApi {
  listExecutionTasks(): Promise<ExecutionTask[]>;
  getExecutionTask(id: string): Promise<ExecutionTask>;
  createExecutionTask(input: CreateExecutionTaskInput): Promise<ExecutionTask>;
  startExecutionTask(id: string): Promise<ExecutionTask | null>;
  pauseExecutionTask(id: string): Promise<ExecutionTask>;
  cancelExecutionTask(id: string): Promise<ExecutionTask>;
}
