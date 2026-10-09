import { createHash } from 'node:crypto';
import type { AiProviderId, AiResult } from '../../shared/ai-contracts.ts';
import { AiError, throwIfAborted } from './errors.ts';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
/** Computed synchronously from validated main-process snapshots, before async preparation. */
export function requestKey(value: unknown): string { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
interface Operation { providerId: AiProviderId; controller: AbortController; promise: Promise<AiResult>; waiters: number }
export class AiRequestControl {
  private operations = new Map<string, Operation>();
  private maxConcurrency: number;
  private timeoutMs: number;
  constructor(maxConcurrency: number, timeoutMs: number) { this.maxConcurrency = maxConcurrency; this.timeoutMs = timeoutMs; }
  get busy(): boolean { return this.operations.size > 0; }
  run(key: string, providerId: AiProviderId, execute: (signal: AbortSignal) => Promise<AiResult>, signal?: AbortSignal): Promise<AiResult> {
    if (signal) throwIfAborted(signal);
    let operation = this.operations.get(key);
    if (operation?.controller.signal.aborted) throw new AiError('BUSY');
    if (!operation) {
      if (this.operations.size >= this.maxConcurrency) throw new AiError('BUSY');
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(new AiError('TIMEOUT')), this.timeoutMs);
      operation = { providerId, controller, waiters: 0, promise: Promise.resolve().then(() => execute(controller.signal)) };
      // No await before registration: duplicates join before concurrency accounting.
      this.operations.set(key, operation);
      const cleanup = () => { clearTimeout(timer); this.operations.delete(key); };
      operation.promise.then(cleanup, cleanup);
    }
    const active = operation; active.waiters++;
    return new Promise<AiResult>((resolve, reject) => {
      let settled = false;
      const finish = (error: unknown, result?: AiResult) => {
        if (settled) return; settled = true; signal?.removeEventListener('abort', cancel); active.waiters--;
        if (error) reject(error); else resolve(result!);
      };
      const cancel = () => { finish(new AiError('CANCELLED')); if (!active.waiters) active.controller.abort(new AiError('CANCELLED')); };
      active.promise.then(result => finish(null, result), error => finish(error));
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }
  cancel(providerId: AiProviderId, reason: AiError): void { for (const operation of this.operations.values()) if (operation.providerId === providerId) operation.controller.abort(reason); }
  async close(): Promise<void> { const pending = [...this.operations.values()]; for (const operation of pending) operation.controller.abort(new AiError('CANCELLED')); await Promise.allSettled(pending.map(operation => operation.promise)); }
}
