import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { lstat, readFile, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { COLLECTION_EXTENSION_ID, COLLECTION_EXTENSION_ORIGIN, COLLECTION_NATIVE_HOST } from '../../shared/collection-identity.ts';
import { COLLECTION_MAX_MESSAGE_BYTES } from '../../shared/collection-contracts.ts';
import type { CollectionErrorCode, CollectionReceiveResult, CollectionResponse, CollectionStatus } from '../../shared/collection-contracts.ts';
import type { WorkspaceStore } from '../store.ts';
import { CollectionError, exactObject, parseCollectionRequest, parseUnambiguousJson } from './validation.ts';
import { hasPreparedConnection, prepareConnectionFiles, safeConnectionDirectory, writeConnectionFile } from './connection.ts';

export const COLLECTION_MAX_PIPE_BYTES = 768 * 1024;
export function collectionHostName(env: Record<string, string | undefined> = process.env): string {
  const override = env.RED_COLLECTION_TEST_HOST;
  if (!override) return COLLECTION_NATIVE_HOST;
  if (env.RED_E2E !== '1' || !/^com\.htc\.workbench\.collection\.test_[a-z0-9]{12}$/.test(override)) throw new CollectionError('INVALID_MESSAGE');
  return override;
}
interface BridgeOptions { nativeHostExecutable: string; nativeHostName?: string; onReceived?(event: CollectionReceiveResult): void }
function errorResponse(code: CollectionErrorCode, requestId: string | null = null): CollectionResponse { return { version: 1, type: 'error', requestId, ok: false, code }; }
function framed(response: CollectionResponse): Buffer { const bytes = Buffer.from(JSON.stringify(response)), header = Buffer.alloc(4); header.writeUInt32LE(bytes.length); return Buffer.concat([header, bytes]); }

export class CollectionBridge {
  readonly connectionDirectory: string;
  private readonly dataRoot: string;
  private readonly store: WorkspaceStore;
  private readonly options: BridgeOptions;
  private readonly nativeHostName: string;
  private readonly pipeName = `htc-collection-${randomUUID()}`;
  private readonly token = randomBytes(32).toString('hex');
  private server: Server | undefined;
  private sockets = new Set<Socket>();
  private state: CollectionStatus['state'] = 'unprepared';
  private prepared = false;
  private preparing: Promise<CollectionStatus> | undefined;
  private closing: Promise<void> | undefined;
  private paused = false;
  private receiving = false;
  constructor(dataRoot: string, store: WorkspaceStore, options: BridgeOptions) {
    this.dataRoot = resolve(dataRoot); this.connectionDirectory = join(this.dataRoot, 'collection-connection'); this.store = store; this.options = options;
    this.nativeHostName = options.nativeHostName ?? COLLECTION_NATIVE_HOST;
    if (this.nativeHostName !== COLLECTION_NATIVE_HOST && !/^com\.htc\.workbench\.collection\.test_[a-z0-9]{12}$/.test(this.nativeHostName)) throw new CollectionError('INVALID_MESSAGE');
  }
  async start(): Promise<void> { try { if (await hasPreparedConnection(this.dataRoot)) await this.prepareConnection(); } catch { this.state = 'unavailable'; } }
  get busy(): boolean { return this.receiving || this.sockets.size > 0 || Boolean(this.preparing); }
  getStatus(): CollectionStatus { return { state: this.state, protocolVersion: 1, nativeHostName: this.nativeHostName, extensionId: COLLECTION_EXTENSION_ID, connectionPrepared: this.prepared, activeConnections: this.sockets.size }; }
  getReceipt(productId: string) { if (this.state === 'closed' || this.paused) throw new CollectionError('APP_BUSY'); return this.store.getCollectionReceipt(productId); }
  pauseForRestore(): () => void {
    if (this.busy || this.state === 'closed') throw new CollectionError('APP_BUSY');
    this.paused = true; if (this.prepared) this.state = 'paused'; let released = false;
    return () => { if (released) return; released = true; if (this.state === 'closed') return; this.paused = false; this.state = this.prepared ? 'ready' : 'unprepared'; };
  }
  async prepareConnection(): Promise<CollectionStatus> {
    if (this.state === 'closed') throw new CollectionError('APP_UNAVAILABLE'); if (this.paused) throw new CollectionError('APP_BUSY');
    if (this.preparing) return this.preparing; if (this.prepared) return this.getStatus();
    this.preparing = this.prepare();
    try { return await this.preparing; } catch { if (!this.closing) this.state = 'unavailable'; throw new CollectionError('APP_UNAVAILABLE'); }
    finally { this.preparing = undefined; }
  }
  private assertOpen(): void { if (this.state === 'closed') throw new CollectionError('APP_UNAVAILABLE'); }
  private async prepare(): Promise<CollectionStatus> {
    let attempt: Server | undefined;
    try {
      await prepareConnectionFiles(this.dataRoot, this.options.nativeHostExecutable, this.nativeHostName); this.assertOpen();
      const server = createServer({ allowHalfOpen: true }, socket => this.connected(socket)); this.server = attempt = server;
      await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(`\\\\.\\pipe\\${this.pipeName}`, () => { server.removeListener('error', reject); resolveListen(); }); });
      server.on('error', () => { if (this.state !== 'closed') this.state = 'unavailable'; }); this.assertOpen();
      await writeConnectionFile(this.dataRoot, 'connection.json', JSON.stringify({ version: 1, pipeName: this.pipeName, token: this.token, extensionId: COLLECTION_EXTENSION_ID }));
      this.assertOpen(); this.prepared = true; this.state = this.paused ? 'paused' : 'ready'; return this.getStatus();
    } catch (error) {
      if (this.server === attempt) this.server = undefined;
      await this.stopServer(attempt); await this.removeOwnedConfig(); throw error;
    }
  }
  private connected(socket: Socket): void {
    socket.on('error', () => {});
    if (this.state === 'closed') { socket.destroy(); return; }
    if (this.sockets.size >= 8) { socket.end(framed(errorResponse('APP_BUSY')), () => socket.destroy()); return; }
    this.sockets.add(socket); let bytes = Buffer.alloc(0), done = false;
    const finish = (response: CollectionResponse) => { if (done) return; done = true; clearTimeout(deadline); socket.end(framed(response), () => socket.destroy()); };
    const deadline = setTimeout(() => finish(errorResponse('TIMEOUT')), 5000); deadline.unref();
    socket.on('close', () => { clearTimeout(deadline); this.sockets.delete(socket); });
    socket.on('end', () => { if (!done) finish(errorResponse('INVALID_MESSAGE')); });
    socket.on('data', chunk => {
      if (done) return;
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (bytes.length + buffer.length > COLLECTION_MAX_PIPE_BYTES + 4) { finish(errorResponse('TOO_LARGE')); return; }
      bytes = Buffer.concat([bytes, buffer]); if (bytes.length < 4) return;
      const length = bytes.readUInt32LE(0); if (length > COLLECTION_MAX_PIPE_BYTES) { finish(errorResponse('TOO_LARGE')); return; }
      if (!length || bytes.length > length + 4) { finish(errorResponse('INVALID_MESSAGE')); return; }
      if (bytes.length === length + 4) finish(this.receive(bytes.subarray(4)));
    });
  }
  private receive(bytes: Buffer): CollectionResponse {
    let requestId: string | null = null;
    try {
      const packet = exactObject(parseUnambiguousJson(bytes, COLLECTION_MAX_PIPE_BYTES), ['version', 'token', 'origin', 'payload'], 'INVALID_MESSAGE');
      if (typeof packet.token !== 'string' || !/^[0-9a-f]{64}$/.test(packet.token) || !timingSafeEqual(Buffer.from(packet.token), Buffer.from(this.token)) || packet.origin !== COLLECTION_EXTENSION_ORIGIN) throw new CollectionError('UNAUTHORIZED');
      if (packet.version !== 1) throw new CollectionError('UNSUPPORTED_VERSION');
      if (typeof packet.payload !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(packet.payload)) throw new CollectionError('INVALID_MESSAGE');
      const decoded = Buffer.from(packet.payload, 'base64'); if (decoded.length > COLLECTION_MAX_MESSAGE_BYTES) throw new CollectionError('TOO_LARGE'); if (decoded.toString('base64') !== packet.payload) throw new CollectionError('INVALID_MESSAGE');
      const request = parseCollectionRequest(decoded); requestId = request.requestId;
      if (this.state === 'closed') throw new CollectionError('APP_UNAVAILABLE');
      if (request.type === 'status') return { version: 1, type: 'status', requestId, ok: true, state: this.paused ? 'paused' : 'ready' };
      if (this.paused) throw new CollectionError('APP_BUSY'); this.receiving = true;
      const receipt = this.store.receiveCollectionSnapshot(request.captureId, request.snapshot);
      try { this.options.onReceived?.(receipt); } catch { /* A closed renderer must never roll back a committed receive. */ }
      return { version: 1, type: 'receipt', requestId, ok: true, receipt };
    } catch (error) { return errorResponse(error instanceof CollectionError ? error.code : 'INTERNAL_ERROR', requestId); }
    finally { this.receiving = false; }
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing; this.state = 'closed'; this.paused = true;
    this.closing = (async () => {
      await this.preparing?.catch(() => {});
      const server = this.server; this.server = undefined; await this.stopServer(server); await this.removeOwnedConfig();
      this.prepared = false;
    })(); return this.closing;
  }
  private async stopServer(server: Server | undefined): Promise<void> {
    const closed = server?.listening ? new Promise<void>(resolveClose => server.close(() => resolveClose())) : Promise.resolve();
    for (const socket of this.sockets) socket.destroy(); await closed; this.sockets.clear();
  }
  private async removeOwnedConfig(): Promise<void> {
    try {
      const directory = await safeConnectionDirectory(this.dataRoot), configPath = join(directory, 'connection.json'), stat = await lstat(configPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (await realpath(configPath)).toLowerCase() !== configPath.toLowerCase()) return;
      const config = JSON.parse(await readFile(configPath, 'utf8')); if (config.token === this.token && config.pipeName === this.pipeName) await unlink(configPath);
    } catch { /* No owned config remains, or an unsafe path must not be touched. */ }
  }
}
