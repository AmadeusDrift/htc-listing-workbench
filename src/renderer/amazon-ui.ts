import type { ListingState } from '../shared/amazon-contracts';

export type TaskRunner = <T>(label: string, task: () => Promise<T>) => Promise<T | undefined>;
export interface DraftGuard { dirty(): boolean; save(): Promise<boolean>; discard(): void }
export const listingStateLabels: Record<ListingState, string> = {
  DRAFT: '编辑中', LOCAL_VALIDATED: '本地校验通过', AMAZON_VALIDATED: '验证预览通过',
  SUBMITTING: '正在提交', SUBMITTED: '提交已接受', PROCESSING: '平台处理中', BUYABLE: '可售',
  DISCOVERABLE: '可见', BLOCKED: '待处理问题', UNKNOWN: '提交结果待确认',
};
