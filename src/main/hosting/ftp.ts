import { Client } from 'basic-ftp';
import type { AccessOptions } from 'basic-ftp';
import { Readable } from 'node:stream';
import { posix } from 'node:path';
import type { HostingProfile } from '../../shared/hosting-contracts.ts';
import type { HostingCredentials } from './validation.ts';
import { HostingError, abortable, classifyHostingError, throwIfAborted } from './errors.ts';

export interface FtpClient {
  readonly closed: boolean;
  access(options: AccessOptions): Promise<unknown>;
  close(): void;
  ensureDir(path: string): Promise<unknown>;
  cd(path: string): Promise<unknown>;
  uploadFrom(source: Readable, path: string): Promise<unknown>;
  size(path: string): Promise<number>;
}
export interface HostingTransport {
  size(profile: HostingProfile, credentials: HostingCredentials, remotePath: string, signal: AbortSignal): Promise<number | null>;
  upload(profile: HostingProfile, credentials: HostingCredentials, remotePath: string, bytes: Buffer, signal: AbortSignal): Promise<number>;
  close(): Promise<void> | void;
}
interface Lease { key: string; client: FtpClient; busy: boolean }
export interface FtpPoolOptions { maxConnections?: number; connectionTimeoutMs?: number; createClient?: () => FtpClient }
/** The single service-owned pool enforces a global cap across all five profiles. */
export class FtpConnectionPool {
  private leases = new Set<Lease>();
  private waiters = new Set<() => void>();
  private controllers = new Set<AbortController>();
  private closed = false;
  private max: number;
  private createClient: () => FtpClient;
  constructor(options: FtpPoolOptions = {}) {
    this.max = options.maxConnections ?? 5;
    if (!Number.isInteger(this.max) || this.max < 1 || this.max > 5) throw new HostingError('INVALID_CONFIG');
    this.createClient = options.createClient ?? (() => new Client(options.connectionTimeoutMs ?? 15000, { allowSeparateTransferHost: false }));
  }
  private wake(): void { for (const wake of this.waiters) wake(); this.waiters.clear(); }
  private discard(lease: Lease): void { lease.client.close(); this.leases.delete(lease); }
  private async acquire(key: string, signal: AbortSignal): Promise<{ lease: Lease; fresh: boolean }> {
    for (;;) {
      throwIfAborted(signal); if (this.closed) throw new HostingError('SERVICE_CLOSED');
      for (const lease of this.leases) if (!lease.busy && lease.client.closed) this.discard(lease);
      const existing = [...this.leases].find(lease => !lease.busy && lease.key === key);
      if (existing) { existing.busy = true; return { lease: existing, fresh: false }; }
      if (this.leases.size >= this.max && ![...this.leases].some(lease => lease.key === key && lease.busy)) {
        const idle = [...this.leases].find(lease => !lease.busy);
        if (idle) this.discard(idle);
      }
      if (this.leases.size < this.max) {
        const lease: Lease = { key, client: this.createClient(), busy: true }; this.leases.add(lease); return { lease, fresh: true };
      }
      let wake!: () => void;
      try { await abortable(new Promise<void>(resolve => { wake = resolve; this.waiters.add(wake); }), signal); }
      finally { this.waiters.delete(wake); }
    }
  }
  async use<T>(profile: HostingProfile, credentials: HostingCredentials, operation: (client: FtpClient) => Promise<T>, signal: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    const controller = new AbortController(), cancel = () => controller.abort(signal.reason instanceof HostingError ? signal.reason : new HostingError('CANCELLED'));
    this.controllers.add(controller); signal.addEventListener('abort', cancel, { once: true });
    let lease: Lease | undefined;
    try {
      const acquired = await this.acquire(`${profile.id}:${profile.generation}`, controller.signal); lease = acquired.lease;
      throwIfAborted(controller.signal);
      const connection = lease.client;
      return await abortable((async () => {
        if (acquired.fresh) await connection.access({ host: profile.host, port: profile.port, user: credentials.username, password: credentials.password, secure: profile.secure, secureOptions: { rejectUnauthorized: true } });
        throwIfAborted(controller.signal);
        return operation(connection);
      })(), controller.signal, () => connection.close());
    } catch (error) { if (lease) this.discard(lease); throw classifyHostingError(error); }
    finally { if (lease) lease.busy = false; signal.removeEventListener('abort', cancel); this.controllers.delete(controller); this.wake(); }
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    for (const controller of this.controllers) controller.abort(new HostingError('CANCELLED'));
    for (const lease of this.leases) this.discard(lease);
    this.wake();
  }
}

export class BasicFtpTransport implements HostingTransport {
  private pool: FtpConnectionPool;
  constructor(pool = new FtpConnectionPool()) { this.pool = pool; }
  async size(profile: HostingProfile, credentials: HostingCredentials, remotePath: string, signal: AbortSignal): Promise<number | null> {
    return this.pool.use(profile, credentials, async client => {
      try { return await client.size(remotePath); }
      catch (error) { if (error && typeof error === 'object' && 'code' in error && Number(error.code) === 550) return null; throw error; }
    }, signal);
  }
  async upload(profile: HostingProfile, credentials: HostingCredentials, remotePath: string, bytes: Buffer, signal: AbortSignal): Promise<number> {
    return this.pool.use(profile, credentials, async client => {
      try { await client.ensureDir(posix.dirname(remotePath)); }
      catch (error) {
        const safe = classifyHostingError(error);
        const responseCode = error && typeof error === 'object' && 'code' in error ? Number(error.code) : NaN;
        // A rejected MKD/CWD is permanent; a reset/timeout during it still needs the bounded connection retry.
        throw safe.code === 'UPLOAD_FAILED' && responseCode >= 500 && responseCode <= 599 ? new HostingError('REMOTE_DIRECTORY_FAILED') : safe;
      }
      throwIfAborted(signal);
      // Always use an absolute system-generated path; ensureDir changes the pooled client's current directory.
      await client.uploadFrom(Readable.from(bytes), remotePath);
      throwIfAborted(signal);
      try { return await client.size(remotePath); }
      catch (error) { const safe = classifyHostingError(error); throw safe.code === 'UPLOAD_FAILED' ? new HostingError('REMOTE_SIZE_UNAVAILABLE') : safe; }
    }, signal);
  }
  async close(): Promise<void> { await this.pool.close(); }
}
