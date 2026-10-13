import type { AiProfile, AiProviderId } from './ai-contracts.ts';
import type { CredentialStatus } from './credential-status.ts';

export const AI_VENDOR_IDS = ['deepseek', 'aliyun','openrouter'] as const;
export type AiVendorId = typeof AI_VENDOR_IDS[number];
export const AI_VENDOR_FUNCTIONS: Record<AiVendorId, readonly AiProviderId[]> = {
  deepseek: ['deepseek', 'deepseek-review'], aliyun: ['aliyun-ocr', 'aidge-segmentation', 'aliyun-image-risk'],openrouter:['openrouter','openrouter-review'],
};
export const AI_FUNCTION_NAMES: Record<AiProviderId, string> = {
  deepseek: 'DeepSeek 文案', 'deepseek-review': 'DeepSeek 复核', 'aliyun-ocr': 'OCR 文字识别', 'aidge-segmentation': '图片分割', 'aliyun-image-risk': '图片侵权风险检测',openrouter:'OpenRouter 文案','openrouter-review':'OpenRouter 复核',
};
export function aiVendorFor(id: AiProviderId): AiVendorId { return id.startsWith('openrouter')?'openrouter':id === 'deepseek' || id === 'deepseek-review' ? 'deepseek' : 'aliyun'; }
/** Public metadata only. Legacy distinct credentials remain intact until explicitly unified. */
export interface AiConnection {
  id: AiVendorId;
  state: 'unconfigured' | 'partial' | 'shared' | 'separate';
  profiles: AiProfile[];
  credentials: (CredentialStatus & { id: AiProviderId })[];
}
export type AiConnectionInput =
  | { id: 'deepseek'|'openrouter'; apiKey: string }
  | { id: 'aliyun'; accessKeyId: string; accessKeySecret: string; securityToken?: string };
export interface AiFunctionSettingsInput { id: AiProviderId; model: string; enabled: boolean; thinking?: boolean }
export interface AiConnectionApi {
  listAiConnections(): Promise<AiConnection[]>;
  saveAiConnection(input: AiConnectionInput): Promise<AiConnection>;
  reuseAiConnection(input: { id: AiVendorId; sourceId: AiProviderId }): Promise<AiConnection>;
  saveAiFunctionSettings(input: AiFunctionSettingsInput): Promise<AiConnection>;
  disconnectAiConnection(id: AiVendorId): Promise<AiConnection>;
  importAiConnectionConfig(): Promise<AiConnection | null>;
  exportAiConnectionTemplate(id: AiVendorId): Promise<{ cancelled: boolean }>;
}
