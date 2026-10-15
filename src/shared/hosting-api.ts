import type { HostedAsset, HostingEnableInput, HostingProfile, HostingRouteInput } from './hosting-contracts.ts';
export interface HostingApi {
  listFtpProfiles(): Promise<HostingProfile[]>;
  importFtpProfile(): Promise<HostingProfile | null>;
  exportFtpProfileTemplate(id: string): Promise<{ cancelled: boolean }>;
  setFtpProfileEnabled(input: HostingEnableInput): Promise<HostingProfile>;
  setFtpProfileRoute(input: HostingRouteInput): Promise<HostingProfile>;
  listHostedAssets(): Promise<HostedAsset[]>;
}
