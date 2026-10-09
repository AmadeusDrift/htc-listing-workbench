export interface WorkspaceBackupResult { cancelled: boolean; createdAt?: string; productCount?: number; assetCount?: number; path?: string; expiresAt?: string | null }
export interface BackupApi {
  copyBackupPassphrase(input: { passphrase: string }): Promise<void>;
  createWorkspaceBackup(input: { passphrase: string }): Promise<WorkspaceBackupResult>;
  restoreWorkspaceBackup(input: { passphrase: string }): Promise<WorkspaceBackupResult>;
}
