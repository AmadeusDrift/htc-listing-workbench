export type ModuleId = 'source' | 'product' | 'sales' | 'pricing' | 'catalog'
  | 'listing' | 'ai' | 'images' | 'assets' | 'publish' | 'tasks'
  | 'observations' | 'procurement' | 'labels' | 'documents';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Ref {
  owner: ModuleId;
  id: string;
  revision: string; // 不把不同模块的数字 revision/哈希混算；明确序列化为稳定字符串
}
export interface TargetScope {
  targetId: string;
  sellerId: string;
  marketplaceId: string;
  mode: 'live' | 'demo';
}
export interface ListingContext {
  productId: string;
  sourceVersion?: Ref; // 旧记录无法还原时允许缺失，不能伪造
  sourceVariantIds: string[];
  salesPlan?: Ref;
  sku?: string;
  target?: TargetScope;
  draft?: Ref;
  task?: Ref;
  taskItemKey?: string;
  operation?: Ref;
}
export type Stage = 'source' | 'classification' | 'schema' | 'pricing' | 'fields'
  | 'generation' | 'download' | 'review' | 'adoption' | 'hosting'
  | 'validation' | 'submission' | 'readback' | 'labels' | 'backup';
export type IssueLocation =
  | { kind: 'field'; pointer: string; label: string; relatedPointers: string[] }
  | { kind: 'image-slot'; runId: string; slotId: string }
  | { kind: 'source-variant'; variantId: string }
  | { kind: 'request'; requestId?: string }
  | { kind: 'unknown'; reason: string };
export type IssueAction =
  | 'edit-source' | 'edit-draft' | 'inspect-evidence' | 'resume-download'
  | 'review-original-submission' | 'open-connection' | 'continue-original-task';
export interface BusinessIssue {
  id: string;
  owner: ModuleId;
  context: ListingContext;
  stage: Stage;
  code: string;
  kind: 'needs-input' | 'platform-rejection' | 'system-failure' | 'unknown-result';
  summary: string;
  locations: IssueLocation[];
  evidenceRefs: Ref[];
  allowedActions: IssueAction[]; // 所有者当前判定，UI 不能自己推导写入资格
  status: 'open' | 'resolved' | 'superseded';
  observedAt: string;
  rawMessage?: string; // 已脱敏的必要原文，不含凭据
}
export interface ReturnContext {
  view: string;
  selectedRecordId?: string;
  filter: Record<string, string>;
  search: string;
  expandedKeys: string[];
  scrollAnchor?: string;
}
export interface OpenContext {
  target: ListingContext;
  issueId?: string;
  location?: IssueLocation;
  returnTo: ReturnContext;
}
export type CommandResult<T> =
  | { kind: 'done'; value: T; changedRefs: Ref[]; issues: BusinessIssue[] }
  | { kind: 'waiting'; operation: Ref; reason: string; nextCheckAt?: string }
  | { kind: 'rejected'; issues: BusinessIssue[] }
  | { kind: 'revision-conflict'; current: Ref; message: string };
