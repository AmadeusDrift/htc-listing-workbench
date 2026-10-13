export interface WorkspaceBackupResult { cancelled: boolean; createdAt?: string; productCount?: number; assetCount?: number; path?: string; expiresAt?: string | null }
export interface RetentionPreview { planId: string; revision: string; automaticEnabled: false; candidates: { path: string; sha256: string; byteSize: number }[]; protected: number }
export interface BackupApi {
  previewRetention(input: { mode: 'manual' | 'automatic' }): Promise<RetentionPreview>;
  applyRetention(input: { planId: string; revision: string }): Promise<{ removed: number; protected: number; changed: number }>;
  copyBackupPassphrase(input: { passphrase: string }): Promise<void>;
  createWorkspaceBackup(input: { passphrase: string }): Promise<WorkspaceBackupResult>;
  restoreWorkspaceBackup(input: { passphrase: string }): Promise<WorkspaceBackupResult>;
}
