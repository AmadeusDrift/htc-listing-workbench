import type { HostedAsset, HostingEnableInput, HostingProfile } from './hosting-contracts.ts';
export interface HostingApi {
  listFtpProfiles(): Promise<HostingProfile[]>;
  importFtpProfile(): Promise<HostingProfile | null>;
  exportFtpProfileTemplate(id: string): Promise<{ cancelled: boolean }>;
  setFtpProfileEnabled(input: HostingEnableInput): Promise<HostingProfile>;
  listHostedAssets(): Promise<HostedAsset[]>;
}
