import { SchemaTransientError } from './schema-retry.ts';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { AmazonCallEvent, AmazonTarget, JsonObject } from '../../shared/amazon-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { isObject, marketplace } from './context.ts';
import type { Credentials } from './vault.ts';
import { productDataRequest } from './read-data.ts';
import type { ProductDataKind } from './read-data.ts';
import type { ItemLabelRecord } from '../../shared/item-label-contracts.ts';
export type LabelDownloadScope=Pick<ItemLabelRecord,'targetId'|'targetGeneration'|'sellerId'|'marketplaceId'|'mode'>;
import { itemLabelDownloads, validateItemLabelRequest } from '../item-labels/adapter.ts';

type SchemaFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface AmazonDependencies {
  fetch?: typeof fetch;
  /** Electron's native network stack, preserving the user's system proxy. */
  schemaFetch?: SchemaFetch;
  dataFetch?: SchemaFetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  resolveAddresses?: (host: string) => Promise<string[]>;
  timeoutMs?: number;
  maxSchemaBytes?: number;
}
interface TransportHooks {
  active(id: string): AmazonTarget;
  generation(id: string): number;
  credentials(id: string): Credentials;
  pause(id: string, message: string): void;
  audit(event: AmazonCallEvent): void;
  redact<T>(value: T): T;
  remember(value: string): void;
}
export class AmazonTransportError extends UserFacingError {
  status: number | null;
  requestId: string | null;
  unknownWrite: boolean;
  response: JsonObject | null;
  constructor(message: string, status: number | null = null, requestId: string | null = null, unknownWrite = false, response: JsonObject | null = null) {
    super(message); this.status = status; this.requestId = requestId; this.unknownWrite = unknownWrite; this.response = response;
  }
}
/** POST completed with a response, but its result cannot safely be adopted or replayed. */
export class AmazonLabelResponseError extends AmazonTransportError {}
interface HttpResult { status: number; headers: Headers; bytes: Buffer; bodyUnavailable?: 'limit' | 'read' }
export interface ApiResult { data: JsonObject; status: number; requestId: string | null }
export type Operation = 'searchDefinitionsProductTypes' | 'getDefinitionsProductType' | 'previewListingsItem' | 'putListingsItem' | 'getListingsItem' | 'patchListingsItem' | 'previewPatchListingsItem';
const ENDPOINTS = { na: 'https://sellingpartnerapi-na.amazon.com', eu: 'https://sellingpartnerapi-eu.amazon.com', fe: 'https://sellingpartnerapi-fe.amazon.com' };

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && [0, 168].includes(b) || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19, 51].includes(b) || a === 203 && b === 0);
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    return /^2[0-9a-f]{3}:/.test(lower) && !lower.startsWith('2001:db8:') && !lower.startsWith('2002:');
  }
  return false;
}
function fakeIpAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 198 && (b === 18 || b === 19);
}
function officialProxySchema(url: URL): boolean {
  // This Amazon-owned PTD origin is documented and verified against the live US
  // endpoint. Arbitrary S3 buckets must not inherit the Fake-IP exception.
  return url.hostname === 'selling-partner-definitions-prod-iad.s3.amazonaws.com' && url.pathname.startsWith('/schema/');
}
function metadata(headers: Headers): { requestId: string | null; rateLimit: string | null } {
  const request = headers.get('x-amzn-requestid'); const rate = headers.get('x-amzn-ratelimit-limit');
  return { requestId: request && /^[A-Za-z0-9_.:-]{1,160}$/.test(request) ? request : null,
    rateLimit: rate && /^\d+(?:\.\d+)?$/.test(rate) && Number(rate) > 0 ? rate : null };
}
export class AmazonTransport {
  private fetcher: typeof fetch;
  private schemaFetcher: SchemaFetch | undefined;
  private dataFetcher: SchemaFetch | undefined;
  private dataQueues = new Map<string, Promise<unknown>>();
  private sleep: (milliseconds: number) => Promise<void>;
  private now: () => number;
  private random: () => number;
  private resolveAddresses: (host: string) => Promise<string[]>;
  private timeout: number;
  private maxSchemaBytes: number;
  private hooks: TransportHooks;
  private tokens = new Map<string, { value: string; expires: number; generation: number }>();
  private nextAllowed = new Map<string, number>();
  private labelDownloads = new Map<string, LabelDownloadScope & { expiration:number }>();
  constructor(hooks: TransportHooks, dependencies: AmazonDependencies = {}) {
    this.hooks = hooks; this.fetcher = dependencies.fetch ?? fetch; this.sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.schemaFetcher = dependencies.schemaFetch;
    this.dataFetcher = dependencies.dataFetch;
    this.now = dependencies.now ?? Date.now; this.random = dependencies.random ?? Math.random;
    this.resolveAddresses = dependencies.resolveAddresses ?? (async host => (await lookup(host, { all: true })).map(result => result.address));
    this.timeout = Math.min(60_000, Math.max(10, dependencies.timeoutMs ?? 15_000)); this.maxSchemaBytes = Math.min(16 * 1024 * 1024, dependencies.maxSchemaBytes ?? 8 * 1024 * 1024);
  }
  clear(id?: string): void { if (id) {this.tokens.delete(id);for(const [uri,scope] of this.labelDownloads)if(scope.targetId===id)this.labelDownloads.delete(uri);} else { this.tokens.clear(); this.labelDownloads.clear(); } }
  private async bounded<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([action(controller.signal), new Promise<T>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new AmazonTransportError('Amazon 请求超时，请稍后检查状态')); }, this.timeout); })]);
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
  private async http(url: string, init: RequestInit, maxBytes = 2 * 1024 * 1024, onHeaders?: (status: number, headers: Headers) => void, fetcher: SchemaFetch = this.fetcher): Promise<HttpResult> {
    const known: { response: Pick<HttpResult, 'status' | 'headers'> | null } = { response: null };
    let bodyFailure: 'limit' | 'read' = 'read';
    try { return await this.bounded(async signal => {
      const response = await fetcher(url, { ...init, signal, redirect: 'manual' });
      known.response = { status: response.status, headers: response.headers }; onHeaders?.(response.status, response.headers);
      const length = Number(response.headers.get('content-length') ?? 0);
      if (!Number.isFinite(length) || length < 0 || length > maxBytes) { bodyFailure = 'limit'; void response.body?.cancel().catch(() => {}); throw new AmazonTransportError('Amazon 响应超过允许大小'); }
      const reader = response.body?.getReader(); const chunks: Buffer[] = []; let size = 0;
      const cancel = () => { void reader?.cancel().catch(() => {}); }; signal.addEventListener('abort', cancel, { once: true });
      if (reader) try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.byteLength; if (size > maxBytes) { bodyFailure = 'limit'; throw new AmazonTransportError('Amazon 响应超过允许大小'); }
          chunks.push(Buffer.from(chunk.value));
        }
      } finally { signal.removeEventListener('abort', cancel); void reader.cancel().catch(() => {}); reader.releaseLock(); }
      return { status: response.status, headers: response.headers, bytes: Buffer.concat(chunks) };
    }); } catch (error) {
      // A bounded-body failure does not erase a status already received. In
      // particular, known auth rejections must not turn into retryable timeouts.
      if (known.response) return { ...known.response, bytes: Buffer.alloc(0), bodyUnavailable: bodyFailure };
      throw error;
    }
  }
  private decode(result: HttpResult): JsonObject {
    try { const value: unknown = JSON.parse(result.bytes.toString('utf8')); if (isObject(value)) return this.hooks.redact(value); }
    catch { /* Invalid upstream payloads never cross the IPC error boundary. */ }
    throw new AmazonTransportError('Amazon 返回的数据格式无效', result.status, this.hooks.redact(metadata(result.headers).requestId));
  }
  private errorBody(result: HttpResult): JsonObject {
    if (result.bodyUnavailable) return { bodyReadError: '响应正文超过大小限制、读取失败或超时；HTTP 状态与请求标识已保留' };
    try { const value: unknown = JSON.parse(result.bytes.toString('utf8')); if (isObject(value)) return this.hooks.redact(value); }
    catch { /* Non-JSON error responses are retained as bounded, redacted text. */ }
    return { body: this.hooks.redact(result.bytes.toString('utf8')) };
  }
  private delay(headers: Headers, attempt: number): number {
    const retry = headers.get('retry-after'); let required = 0;
    if (retry) { const seconds = Number(retry); required = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(retry) - this.now()) || 0; }
    const rate = Number(metadata(headers).rateLimit ?? 0);
    return Math.max(required, rate > 0 ? 1000 / rate : 0, 250 * 2 ** attempt + Math.floor(this.random() * 200));
  }
  private log(target: AmazonTarget, operation: string, start: number, attempts: number, status: number | null, headers: Headers, category: string | null): void {
    this.hooks.audit(this.hooks.redact({ id: randomUUID(), at: new Date(this.now()).toISOString(), targetId: target.id, operation, mode: target.mode, status,
      ...metadata(headers), retries: Math.max(0, attempts - 1), durationMs: Math.max(0, this.now() - start), category }));
  }
  private async token(target: AmazonTarget, write: boolean, fetcher?: SchemaFetch, beforeSend?: () => void): Promise<string> {
    beforeSend?.();
    const generation = this.hooks.generation(target.id); const existing = this.tokens.get(target.id);
    if (existing && existing.generation === generation && existing.expires > this.now() + 60_000) return existing.value;
    const credentials = this.hooks.credentials(target.id); const start = this.now(); let status: number | null = null; let headers = new Headers(); let attempts = 0; let category: string | null = null;
    try {
      for (let attempt = 0; attempt < (write ? 1 : 3); attempt++) {
        beforeSend?.();
        this.hooks.active(target.id); attempts++;
        let result: HttpResult;
        try { result = await this.http('https://api.amazon.com/auth/o2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'user-agent': 'HTC/0.2.0 (Language=TypeScript; Platform=Windows)' },
          body: new URLSearchParams({ grant_type: 'refresh_token', client_id: credentials.clientId, client_secret: credentials.clientSecret, refresh_token: credentials.refreshToken }).toString() }, 2 * 1024 * 1024, undefined, fetcher ?? this.fetcher); }
        catch { if (!write && attempt < 2) { await this.sleep(250 * 2 ** attempt + Math.floor(this.random() * 200)); continue; } throw new AmazonTransportError('Amazon 授权服务连接失败，请稍后重试'); }
        status = result.status; headers = result.headers;
        beforeSend?.();
        if (generation !== this.hooks.generation(target.id)) throw new AmazonTransportError('授权配置已变化，请重新同步');
        if ([400, 401, 403].includes(status)) { this.hooks.pause(target.id, 'Amazon 授权失效，店铺已暂停，请检查或轮换授权'); throw new AmazonTransportError('Amazon 授权失效，店铺已暂停，请重新导入配置', status); }
        if (status === 429 || status >= 500) {
          const delay = this.delay(headers, attempt);
          if (!write && attempt < 2 && delay <= 30_000) { await this.sleep(delay); continue; }
          if (status === 429) this.hooks.pause(target.id, 'Amazon 授权服务持续限流，店铺已暂停');
          throw new AmazonTransportError(status === 429 ? 'Amazon 授权服务限流，请稍后解除暂停' : 'Amazon 授权服务暂时不可用', status);
        }
        if (status < 200 || status >= 300) throw new AmazonTransportError('Amazon 授权请求未通过', status);
        let value: Record<string, unknown>;
        try { value = JSON.parse(result.bytes.toString('utf8')) as Record<string, unknown>; } catch { throw new AmazonTransportError('Amazon 授权响应格式无效'); }
        if (typeof value.access_token !== 'string' || !value.access_token || value.access_token.length > 4096 || String(value.token_type).toLowerCase() !== 'bearer' || typeof value.expires_in !== 'number' || value.expires_in <= 0) throw new AmazonTransportError('Amazon 授权响应格式无效');
        if (generation !== this.hooks.generation(target.id)) throw new AmazonTransportError('授权配置已变化，请重新预览');
        this.hooks.remember(value.access_token); this.tokens.set(target.id, { value: value.access_token, generation, expires: this.now() + Math.min(value.expires_in, 3600) * 1000 }); return value.access_token;
      }
      throw new AmazonTransportError('Amazon 授权连接失败');
    } catch (error) { category = status === 429 ? 'rate_limit' : 'authorization'; throw error instanceof UserFacingError ? error : new AmazonTransportError('Amazon 授权连接失败'); }
    finally { this.log(target, 'lwaToken', start, attempts, status, headers, category); }
  }
  async api(target: AmazonTarget, operation: Operation, path: string, query: Record<string, string>, body?: JsonObject, beforeSend?: () => void): Promise<ApiResult> {
    this.hooks.active(target.id); marketplace(target.marketplaceId, target.region);
    const write = operation === 'putListingsItem' || operation === 'patchListingsItem'; const method = operation === 'patchListingsItem' || operation === 'previewPatchListingsItem' ? 'PATCH' : operation === 'putListingsItem' || operation === 'previewListingsItem' ? 'PUT' : 'GET';
    const validPath = operation === 'searchDefinitionsProductTypes' ? path === '/definitions/2020-09-01/productTypes'
      : operation === 'getDefinitionsProductType' ? /^\/definitions\/2020-09-01\/productTypes\/[A-Z0-9][A-Z0-9_]*$/.test(path)
      : /^\/listings\/2021-08-01\/items\/[^/]+\/[^/]+$/.test(path);
    if (!validPath || query.marketplaceIds !== target.marketplaceId) throw new UserFacingError('Amazon 请求上下文不匹配');
    if ((operation === 'previewListingsItem' || operation === 'previewPatchListingsItem') && query.mode !== 'VALIDATION_PREVIEW' || write && 'mode' in query) throw new UserFacingError('Amazon 请求模式无效');
    const url = new URL(path, ENDPOINTS[target.region]);
    if (url.pathname !== path) throw new UserFacingError('SKU 或 Amazon 请求路径包含不允许的路径片段');
    url.search = new URLSearchParams(query).toString();
    const generation = this.hooks.generation(target.id); const start = this.now(); const rateKey = `${target.id}:${operation === 'previewListingsItem' ? 'putListingsItem' : operation === 'previewPatchListingsItem' ? 'patchListingsItem' : operation}`;
    let status: number | null = null; let headers = new Headers(); let attempts = 0; let category: string | null = null; let authPaused = false;
    try {
      const accessToken = await this.token(target, write,undefined,beforeSend);
      for (let attempt = 0; attempt < (write ? 1 : 3); attempt++) {
        const wait = (this.nextAllowed.get(rateKey) ?? 0) - this.now();
        if (wait > 30_000) throw new AmazonTransportError('Amazon 调用速率较低，请稍后再试');
        if (wait > 0) await this.sleep(wait);
        this.hooks.active(target.id);
        if (generation !== this.hooks.generation(target.id)) throw new UserFacingError('授权配置已变化，请重新预览');
        beforeSend?.(); attempts++;
        let result: HttpResult;
        try { result = await this.http(url.href, { method, headers: { 'x-amz-access-token': accessToken, 'x-amz-date': new Date(this.now()).toISOString().replace(/[:-]|\.\d{3}/g, ''),
          'user-agent': 'HTC/0.2.0 (Language=TypeScript; Platform=Windows)', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }, 2 * 1024 * 1024, (code, receivedHeaders) => {
            status = code; headers = receivedHeaders;
            if (code === 401 || code === 403) { this.clear(target.id); this.hooks.pause(target.id, 'Amazon 授权或权限失败，店铺已暂停'); authPaused = true; }
          }); }
        catch { if (!write && attempt < 2) { await this.sleep(250 * 2 ** attempt + Math.floor(this.random() * 200)); continue; }
          if(operation==='getDefinitionsProductType')throw new SchemaTransientError('NETWORK');
          throw new AmazonTransportError(write ? '提交连接中断，结果未知；请回读核对，禁止重放' : 'Amazon 网络请求失败或超时', null, null, write); }
        status = result.status; headers = result.headers;
        const { requestId, rateLimit } = this.hooks.redact(metadata(headers)); if (rateLimit) this.nextAllowed.set(rateKey, this.now() + 1000 / Number(rateLimit));
        if (status === 401 || status === 403) { this.clear(target.id); if (!authPaused) this.hooks.pause(target.id, 'Amazon 授权或权限失败，店铺已暂停'); throw new AmazonTransportError('Amazon 授权或权限失败，店铺已暂停；请核对授权和角色', status, requestId, false, this.errorBody(result)); }
        if (status === 429 || status >= 500 || status === 408) {
          const delay = this.delay(headers, attempt);
          if (!write && attempt < 2 && delay <= 30_000) { await this.sleep(delay); continue; }
          if (status === 429) this.hooks.pause(target.id, 'Amazon 持续限流，店铺已暂停；请稍后解除暂停');
          throw new AmazonTransportError(status === 429 ? 'Amazon 持续限流，店铺已暂停' : write ? '提交结果未知，请回读核对；禁止重放' : 'Amazon 服务暂时不可用，请稍后重试', status, requestId, write && status !== 429, this.errorBody(result));
        }
        if (status < 200 || status >= 300) throw new AmazonTransportError(`Amazon 请求未通过（HTTP ${status}），请核对店铺权限、SKU 和参数`, status, requestId, false, this.errorBody(result));
        if (result.bodyUnavailable) {
          // Receiving HTTP 200 does not mean the streamed JSON finished. Only
          // retry read/preview requests; a formal submission remains unknown.
          if (!write && result.bodyUnavailable === 'read' && attempt < 2) { await this.sleep(250 * 2 ** attempt + Math.floor(this.random() * 200)); continue; }
          if(operation==='getDefinitionsProductType'&&status===200&&result.bodyUnavailable==='read')throw new SchemaTransientError('BODY_INCOMPLETE');
          const reason = result.bodyUnavailable === 'limit' ? 'Amazon 响应正文超过允许大小' : 'Amazon 响应正文读取中断或超时';
          throw new AmazonTransportError(write ? `${reason}，提交结果未知；请回读核对，禁止重放` : reason, status, requestId, write, this.errorBody(result));
        }
        let data: JsonObject;
        try { data = this.decode(result); } catch { throw new AmazonTransportError(write ? '提交响应无法确认，结果未知；请回读核对' : 'Amazon 返回的数据格式无效', status, requestId, write, this.errorBody(result)); }
        return { data, status, requestId };
      }
      throw new AmazonTransportError('Amazon 请求未完成');
    } catch (error) {
      category = status === 429 ? 'rate_limit' : status === 401 || status === 403 ? 'authorization' : 'network';
      throw error instanceof UserFacingError ? error : new AmazonTransportError('Amazon 请求未完成', status, this.hooks.redact(metadata(headers).requestId), write && attempts > 0);
    } finally { this.log(target, operation, start, attempts, status, headers, category); }
  }
  /** Optional read-only capabilities have their own quota and permission failures. */
  async readData(target: AmazonTarget, kind: ProductDataKind, input: Record<string,string>, beforeSend?: () => void): Promise<ApiResult> {
    const request = productDataRequest(target,kind,input), generation = this.hooks.generation(target.id), key = target.id+':data:'+kind;
    const previous = this.dataQueues.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      beforeSend?.();
      this.hooks.active(target.id);
      if (generation !== this.hooks.generation(target.id)) throw new UserFacingError('授权配置已变化，请重新同步');
      return this.readDataRequest(target,request,generation,key,beforeSend);
    });
    this.dataQueues.set(key,pending);
    try { return await pending; } finally { if (this.dataQueues.get(key) === pending) this.dataQueues.delete(key); }
  }
  private async readDataRequest(target: AmazonTarget, request: ReturnType<typeof productDataRequest>, generation: number, key: string, beforeSend?: () => void): Promise<ApiResult> {
    const url = new URL(request.path,ENDPOINTS[target.region]); url.search = new URLSearchParams(request.query).toString();
    const start = this.now(); let attempts = 0, status: number | null = null, headers = new Headers(), category: string | null = null;
    const assertActive = () => { beforeSend?.(); this.hooks.active(target.id); if (generation !== this.hooks.generation(target.id)) throw new UserFacingError('授权配置已变化，请重新同步'); };
    try {
      assertActive();
      const token = await this.token(target,false,this.dataFetcher,assertActive);
      for (let attempt=0; attempt<3; attempt++) {
        assertActive();
        const wait = (this.nextAllowed.get(key) ?? 0)-this.now();
        if (wait>30_000) throw new AmazonTransportError('此数据接口仍在限流冷却中，请稍后同步',429);
        if (wait>0) await this.sleep(wait);
        assertActive(); attempts++;
        this.nextAllowed.set(key,this.now()+request.interval);
        let result: HttpResult;
        try { result = await this.http(url.href,{method:'GET',headers:{'x-amz-access-token':token,'content-type':'application/json','user-agent':'HTC Product Data'}},2*1024*1024,undefined,this.dataFetcher ?? this.fetcher); }
        catch { if (attempt<2) continue; throw new AmazonTransportError('Amazon 数据接口网络请求失败或超时'); }
        assertActive(); status=result.status; headers=result.headers;
        const {requestId,rateLimit} = this.hooks.redact(metadata(headers));
        if (rateLimit) this.nextAllowed.set(key,Math.max(this.nextAllowed.get(key) ?? 0,this.now()+1000/Number(rateLimit)));
        if (status===401) { this.clear(target.id); this.hooks.pause(target.id,'Amazon 授权失效，请检查连接'); throw new AmazonTransportError('Amazon 授权失效，请检查连接',status,requestId); }
        if (status===403) throw new AmazonTransportError('此数据接口权限不足，现有上架连接仍保留；请核对对应 SP-API 角色',status,requestId,false,this.errorBody(result));
        if (status===429 || status>=500 || status===408) {
          const delay = Math.max(request.interval,this.delay(headers,attempt));
          this.nextAllowed.set(key,Math.max(this.nextAllowed.get(key) ?? 0,this.now()+delay));
          if (attempt<2 && delay<=30_000) continue;
          throw new AmazonTransportError(status===429?'此数据接口限流，请稍后同步':'Amazon 数据服务暂时不可用',status,requestId,false,this.errorBody(result));
        }
        if (status<200 || status>=300) throw new AmazonTransportError('Amazon 数据读取未通过（HTTP '+status+'）',status,requestId,false,this.errorBody(result));
        return {data:this.decode(result),status,requestId};
      }
      throw new AmazonTransportError('Amazon 数据读取未完成');
    } catch (error) { category=status===403 || status===401?'authorization':status===429?'rate_limit':'network'; throw error instanceof UserFacingError?error:new AmazonTransportError('Amazon 数据读取未完成',status); }
    finally { this.log(target,request.operation,start,attempts,status,headers,category); }
  }
  /** One attempt per persisted label job; the job owns the finite retry budget. */
  async createMarketplaceItemLabels(target: AmazonTarget, raw: JsonObject, beforeSend?: () => void): Promise<ApiResult> {
    const body = validateItemLabelRequest(raw, target.marketplaceId);
    if (target.mode !== 'live') throw new UserFacingError('演示商品不能获取真实平台标签');
    marketplace(target.marketplaceId, target.region);
    const generation = this.hooks.generation(target.id), key = target.id + ':createMarketplaceItemLabels', start = this.now();
    let status: number | null = null, headers = new Headers(), attempts = 0, category: string | null = null;
    const guard = (checkPermit = true) => { if (checkPermit) beforeSend?.(); this.hooks.active(target.id); if (generation !== this.hooks.generation(target.id)) throw new UserFacingError('授权配置已变化，标签请求已停止'); };
    try {
      guard(); const token = await this.token(target, true, this.dataFetcher, guard);
      const wait = (this.nextAllowed.get(key) ?? 0) - this.now();
      if (wait > 30_000) throw new AmazonTransportError('商品标签接口仍在限流冷却中', 429);
      if (wait > 0) await this.sleep(wait); guard(); attempts = 1; this.nextAllowed.set(key, this.now() + 500);
      let result: HttpResult;
      try { result = await this.http(ENDPOINTS[target.region] + '/inbound/fba/2024-03-20/items/labels', { method: 'POST', headers: { 'x-amz-access-token': token, 'content-type': 'application/json', 'user-agent': 'HTC Item Labels' }, body: JSON.stringify(body) }, 2 * 1024 * 1024, (code, value) => { status = code; headers = value; }, this.dataFetcher ?? this.fetcher); }
      catch { throw new AmazonTransportError('标签请求连接中断，未获得可核验文件', status, this.hooks.redact(metadata(headers).requestId), true); }
      status = result.status; headers = result.headers;
      const { requestId, rateLimit } = this.hooks.redact(metadata(headers));
      if (rateLimit) this.nextAllowed.set(key, this.now() + 1000 / Number(rateLimit));
      if (status === 401) { this.clear(target.id); throw new AmazonTransportError('Amazon 标签授权失效，请检查连接', status, requestId); }
      if (status === 403) throw new AmazonTransportError('商品标签接口权限不足，请核对 Amazon Fulfillment 角色；上架结果仍保留', status, requestId, false, this.errorBody(result));
      if (status === 429 || status >= 500 || status === 408) { this.nextAllowed.set(key, this.now() + this.delay(headers, 0)); throw new AmazonTransportError('Amazon 商品标签服务暂时不可用', status, requestId); }
      if (status < 200 || status >= 300) throw new AmazonTransportError('Amazon 商品标签请求未通过（HTTP ' + status + '）', status, requestId, false, this.errorBody(result));
      try{
        guard(false);
        if(status!==200)throw new UserFacingError('标签成功响应状态无法采用');
        const data = this.decode(result), documents = itemLabelDownloads(data, this.now());
        this.restoreItemLabelDownloads(target,{targetId:target.id,targetGeneration:generation,sellerId:target.sellerId,marketplaceId:target.marketplaceId,mode:target.mode},documents);
        return { data, status, requestId };
      }catch{throw new AmazonLabelResponseError('标签响应已收到但无法安全采用，请核对原请求；禁止重新生成',status,requestId,false,this.errorBody(result));}
    } catch (error) { category = status === 401 || status === 403 ? 'authorization' : status === 429 ? 'rate_limit' : 'labels'; throw error instanceof UserFacingError ? error : new AmazonTransportError('Amazon 商品标签请求失败', status); }
    finally { this.log(target, 'createMarketplaceItemLabels', start, attempts, status, headers, category); }
  }
  /** Main-process only: caller must first validate persisted label/request/fingerprint ownership. */
  restoreItemLabelDownloads(target:AmazonTarget,scope:LabelDownloadScope,documents:{uri:string;expiration:number}[]):void{
    const active=this.hooks.active(target.id);
    if(scope.mode!=='live'||active.mode!==scope.mode||target.id!==scope.targetId||active.id!==scope.targetId||active.sellerId!==scope.sellerId||active.marketplaceId!==scope.marketplaceId||this.hooks.generation(target.id)!==scope.targetGeneration)throw new UserFacingError('标签下载恢复的店铺或授权身份已变化');
    const verified=itemLabelDownloads({documentDownloads:documents.map(doc=>({downloadType:'URL',uri:doc.uri,expiration:new Date(doc.expiration).toISOString()}))},this.now());
    for(const [uri,entry] of this.labelDownloads)if(entry.expiration<=this.now())this.labelDownloads.delete(uri);
    for(const document of verified)this.labelDownloads.set(document.uri,{...scope,expiration:document.expiration});
  }
  private labelDownloadAuthorized(uri:string):boolean{
    const scope=this.labelDownloads.get(uri);if(!scope||scope.expiration<=this.now())return false;
    try{const target=this.hooks.active(scope.targetId);return target.mode===scope.mode&&target.sellerId===scope.sellerId&&target.marketplaceId===scope.marketplaceId&&this.hooks.generation(scope.targetId)===scope.targetGeneration;}catch{return false;}
  }
  async downloadItemLabel(raw: string): Promise<Buffer> {
    // Only exact, unexpired URLs returned by this transport's authenticated label call.
    let url: URL; try { url = new URL(raw); } catch { throw new UserFacingError('标签下载来源无效'); }
    if (!this.labelDownloadAuthorized(url.href)) throw new UserFacingError('标签下载地址未经当前 Amazon 响应授权或已过期');
    let addresses: string[]; try { addresses = await this.bounded(() => this.resolveAddresses(url.hostname)); } catch { throw new UserFacingError('标签下载地址解析失败或超时'); }
    if (!this.labelDownloadAuthorized(url.href)) throw new UserFacingError('标签下载地址未经当前 Amazon 响应授权或已过期');
    // The exact URL is a short-lived capability from an authenticated Amazon
    // response. Native HTTPS keeps certificate verification and system proxy
    // routing; no other path, query, bucket or mixed DNS answer inherits trust.
    const proxyLabel = !!this.dataFetcher && addresses.length > 0 && addresses.every(fakeIpAddress);
    if (!proxyLabel && (!addresses.length || addresses.some(address => !publicAddress(address)))) throw new UserFacingError('标签下载地址解析到非公开网络，已阻止');
    const result = await this.http(url.href, { method: 'GET', headers: { accept: 'application/pdf' }, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' }, 32 * 1024 * 1024, undefined, this.dataFetcher ?? this.fetcher);
    if (result.status >= 300 && result.status < 400) throw new UserFacingError('标签下载包含重定向，已阻止');
    if(result.status===408||result.status===429||result.status>=500)throw new AmazonTransportError('标签文件下载暂时不可用（HTTP '+result.status+'）',result.status,null,false);
    if (result.status !== 200 || result.bodyUnavailable) throw new UserFacingError('标签文件下载未完成');
    const contentType = (result.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (contentType && !['application/pdf','application/octet-stream','binary/octet-stream'].includes(contentType)) throw new UserFacingError('标签响应不是 PDF 文件');
    return result.bytes;
  }
  async schemaLink(target: AmazonTarget, raw: unknown, beforeSend?:()=>void): Promise<{ schema: JsonObject; checksum: string }> {
    if (!isObject(raw) || !isObject(raw.link) || raw.link.verb !== 'GET' || typeof raw.link.resource !== 'string' || typeof raw.checksum !== 'string') throw new UserFacingError('Amazon Schema 下载描述无效');
    let url: URL; try { url = new URL(raw.link.resource); } catch { throw new UserFacingError('Amazon Schema 地址无效'); }
    const trusted = /^(?:[a-z0-9-]+\.)*s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname) || url.hostname === 'schemas.amazon.com';
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !trusted || isIP(url.hostname)) throw new UserFacingError('Amazon Schema 地址不可信，下载已阻止');
    beforeSend?.();
    const start = this.now(); let status: number | null = null; let headers = new Headers(); let attempts = 0; let category: string | null = null;
    try {
      let addresses:string[];
      try{addresses=await this.bounded(() => this.resolveAddresses(url.hostname));}catch{throw new SchemaTransientError('NETWORK');}
      const proxySchema = !!this.schemaFetcher && officialProxySchema(url);
      if (!addresses.length || addresses.some(address => !publicAddress(address) && !(proxySchema && fakeIpAddress(address)))) throw new UserFacingError('Amazon Schema 地址解析到非公开网络，下载已阻止');
      let result: HttpResult | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        beforeSend?.();this.hooks.active(target.id); attempts++;
        try { result = await this.http(url.href, { method: 'GET', headers: { accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' }, this.maxSchemaBytes, undefined, this.schemaFetcher ?? this.fetcher); }
        catch { if (attempt < 2) { await this.sleep(250 * 2 ** attempt + Math.floor(this.random() * 200)); continue; } throw new SchemaTransientError('NETWORK'); }
        status = result.status; headers = result.headers;
        if ((status >= 500 || status === 429) && attempt < 2) { const delay = this.delay(headers, attempt); if (delay <= 30_000) { await this.sleep(delay); continue; } }
        if (status >= 300 && status < 400) throw new UserFacingError('Amazon Schema 下载包含重定向，已阻止');
        if (status !== 200) throw new UserFacingError('Amazon Schema 下载未成功');
        if (result.bodyUnavailable === 'limit') throw new UserFacingError('Amazon Schema 正文超过允许大小，内容未缓存');
        if (result.bodyUnavailable) {
          if (attempt < 2) { await this.sleep(250 * 2 ** attempt + Math.floor(this.random() * 200)); continue; }
          throw new SchemaTransientError('BODY_INCOMPLETE');
        }
        break;
      }
      if (!result || status !== 200) throw new UserFacingError('Amazon Schema 下载未成功');
      const expected = Buffer.from(raw.checksum, 'base64'); const actual = createHash('md5').update(result.bytes).digest();
      if (expected.length !== 16 || !timingSafeEqual(expected, actual)) throw new UserFacingError('Amazon Schema checksum 校验失败，内容未缓存');
      return { schema: this.decode(result), checksum: raw.checksum };
    } catch (error) { category = 'schema'; throw error instanceof UserFacingError ? error : new UserFacingError('Amazon Schema 下载失败'); }
    finally { this.log(target, 'downloadSchema', start, attempts, status, headers, category); }
  }
}
