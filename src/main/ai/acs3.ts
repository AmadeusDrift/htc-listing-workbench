import { createHash, createHmac } from 'node:crypto';
import type { AliyunCredentials } from "./primitives.ts";

interface Acs3Request extends AliyunCredentials {
  host: string; action: string; version: string; query: Record<string, string>; body: Buffer; contentType?: string; now: Date; nonce: string;
}
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** RPC POST signature, verified against Alibaba's fixed ACS3-HMAC-SHA256 vector. */
export function signAcs3(request: Acs3Request): { url: string; headers: Record<string, string> } {
  const query = Object.keys(request.query).sort().map(key => `${encode(key)}=${encode(request.query[key])}`).join('&');
  const digest = hash(request.body);
  const headers: Record<string, string> = { host: request.host, 'x-acs-action': request.action, 'x-acs-version': request.version, 'x-acs-content-sha256': digest, 'x-acs-date': request.now.toISOString().replace(/\.\d{3}Z$/, 'Z'), 'x-acs-signature-nonce': request.nonce };
  if (request.contentType) headers['content-type'] = request.contentType;
  if (request.securityToken) headers['x-acs-security-token'] = request.securityToken;
  const names = Object.keys(headers).sort(), signedHeaders = names.join(';');
  const canonical = ['POST', '/', query, names.map(name => `${name}:${headers[name].trim()}\n`).join(''), signedHeaders, digest].join('\n');
  const signature = createHmac('sha256', request.accessKeySecret).update(`ACS3-HMAC-SHA256\n${hash(canonical)}`).digest('hex');
  headers.authorization = `ACS3-HMAC-SHA256 Credential=${request.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`;
  headers.accept = 'application/json';
  return { url: `https://${request.host}/${query ? `?${query}` : ''}`, headers };
}
