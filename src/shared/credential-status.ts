/** Public availability and stored intent only; no secret, ciphertext or key fingerprint. */
export type CredentialReadState = 'absent' | 'encryption-unavailable' | 'unreadable' | 'metadata-mismatch' | 'readable';
export interface CredentialStatus {
  state: Exclude<CredentialReadState, 'readable'> | 'configured-disabled' | 'ready';
  storedConfigured: boolean;
  storedEnabled: boolean;
}
export function credentialStatus(readState: CredentialReadState, storedConfigured: boolean, storedEnabled: boolean): CredentialStatus {
  const state = readState === 'readable' ? !storedConfigured ? 'metadata-mismatch' : storedEnabled ? 'ready' : 'configured-disabled' : readState;
  return { state, storedConfigured, storedEnabled };
}
