import { AsyncLocalStorage } from 'node:async_hooks';
import type { AiPurposeSnapshot } from '../../../shared/ai-purpose-contracts.ts';
import type { ListingExecutionMode } from '../../../shared/ai-batch-contracts.ts';
export interface TaskAiScope {
 taskId:string;rowKey:string;phase:string;mode:ListingExecutionMode;
 explicitContinueAt?:string;waitingOperationId?:string;credentialScope?:string;purposes?:AiPurposeSnapshot[];authorize():boolean;
}
export const taskAiContext=new AsyncLocalStorage<TaskAiScope>();
export class BatchWaitingError extends Error {
 readonly operationId:string;
 constructor(operationId:string){super('等待原 Batch 结果；保留当前步骤、请求身份与次数');this.name='BatchWaitingError';this.operationId=operationId;}
}
