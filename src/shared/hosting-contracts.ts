export const HOSTING_PROFILE_IDS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'] as const;
export type HostingProfileId = typeof HOSTING_PROFILE_IDS[number];
/** Safe to expose to renderer; the username and password exist only in the main-process vault. */
export interface HostingProfile {
  id: HostingProfileId;
  name: 'Alpha' | 'Beta' | 'Gamma' | 'Delta' | 'Epsilon';
  host: string;
  port: number;
  secure: boolean;
  remoteRoot: string;
  publicBaseUrl: string;
  enabled: boolean;
  configured: boolean;
  generation: number;
}
export type HostingStatus = 'PENDING' | 'UPLOADING' | 'VERIFYING' | 'AVAILABLE' | 'FAILED' | 'CANCELLED';
export const HOSTING_ERROR_CODES = [
  'INVALID_CONFIG', 'INVALID_INPUT', 'PROFILE_DISABLED', 'PROFILE_CHANGED', 'CREDENTIAL_NOT_FOUND', 'ENCRYPTION_UNAVAILABLE',
  'AUTH_FAILED', 'CONNECT_TIMEOUT', 'CONNECTION_LIMIT', 'REMOTE_DIRECTORY_FAILED', 'LOCAL_FILE_MISSING', 'LOCAL_FILE_CHANGED',
  'ASSET_NOT_CONFIRMED', 'UPLOAD_FAILED', 'REMOTE_SIZE_UNAVAILABLE', 'SIZE_MISMATCH', 'PUBLIC_URL_NOT_FOUND',
  'PUBLIC_URL_TIMEOUT', 'PUBLIC_URL_UNSAFE', 'PUBLIC_URL_CONTENT_MISMATCH', 'PUBLIC_URL_UNAVAILABLE', 'CANCELLED', 'SERVICE_CLOSED',
] as const;
export type HostingErrorCode = typeof HOSTING_ERROR_CODES[number];
export interface HostingAttempt {
  attempt: number;
  status: 'AVAILABLE' | 'FAILED' | 'CANCELLED';
  errorCode: HostingErrorCode | null;
  startedAt: string;
  finishedAt: string;
}
export interface HostedAsset {
  id: string;
  assetId: string;
  profileId: HostingProfileId;
  batchId: string;
  generation: number;
  sha256: string;
  byteSize: number;
  mimeType: 'image/png' | 'image/jpeg';
  remotePath: string;
  publicUrl: string;
  status: HostingStatus;
  attempts: number;
  history: HostingAttempt[];
  errorCode: HostingErrorCode | null;
  createdAt: string;
  updatedAt: string;
}
export interface HostingUploadInput { assetId: string; profileId: string; generation: number; batchId: string }
export interface HostingEnableInput { id: string; enabled: boolean }
