import type {AiCredentials} from './primitives.ts';
export function containsSecret(value: unknown, credentials: AiCredentials): boolean {
  const json = JSON.stringify(value);
  return Object.values(credentials).some(secret => typeof secret === 'string' && (json.includes(secret) || json.includes(JSON.stringify(secret).slice(1,-1)) || json.includes(encodeURIComponent(secret))));
}
