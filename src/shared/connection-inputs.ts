/** Write-only form inputs. Saved credentials are never returned to the renderer. */
export type AiProviderConfigInput =
  | { id:'openrouter'|'openrouter-review';model:string;apiKey:string }
  | { id: 'deepseek' | 'deepseek-review'; model: 'deepseek-flash' | 'deepseek-v4-pro'; apiKey: string }
  | { id: 'aliyun-ocr' | 'aidge-segmentation' | 'aliyun-image-risk'; accessKeyId: string; accessKeySecret: string; securityToken?: string };
export interface MiaoshouConfigInput { appKey: string; appSecret: string }
export interface AmazonCredentialInput {
  name: string; sellerId: string; marketplaceId: string; region: 'na' | 'eu' | 'fe'; locale: string;
  clientId: string; clientSecret: string; refreshToken: string;
}
