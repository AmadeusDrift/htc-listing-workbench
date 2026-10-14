import { AiError, abortError } from './errors.ts';
import type { AdapterContext } from './transport.ts';
import type { TransportRunEvidence } from '../../shared/run-evidence-contracts.ts';

/** A stopped caller does not cancel a dispatched provider operation. Collection is
 * bounded by the original operation deadline, including time spent before headers. */
export function responseCollection(caller: AbortSignal, context: AdapterContext) {
  const controller = new AbortController();
  if (context.responseTimeoutMs !== undefined && (!Number.isSafeInteger(context.responseTimeoutMs) || context.responseTimeoutMs < 1 || context.responseTimeoutMs > 1800000)) throw new AiError('INVALID_CONFIG');
  const deadline = context.responseDeadlineAt ?? Date.now() + (context.responseTimeoutMs ?? 120000);
  if (!Number.isSafeInteger(deadline) || deadline < 0 || context.responseBodyTimeoutMs !== undefined && (!Number.isSafeInteger(context.responseBodyTimeoutMs) || context.responseBodyTimeoutMs < 1 || context.responseBodyTimeoutMs > 1800000)) throw new AiError('INVALID_CONFIG');
  const expire = (source: 'TOTAL_TIMEOUT' | 'BODY_TIMEOUT') => controller.abort(Object.assign(new AiError('TIMEOUT'), { abortSource: source }));
  const remaining = Math.max(0, deadline - Date.now());
  if (remaining > 1800000) throw new AiError('INVALID_CONFIG');
  if (!remaining) expire('TOTAL_TIMEOUT');
  const totalTimer = setTimeout(() => expire('TOTAL_TIMEOUT'), remaining);
  let bodyTimer: ReturnType<typeof setTimeout> | undefined;
  const followTimeout = () => { const error = abortError(caller.reason); if (error.code === 'TIMEOUT') controller.abort(error); };
  caller.addEventListener('abort', followTimeout);
  if (caller.aborted) followTimeout();
  return {
    signal: controller.signal,
    headers() { if (context.responseBodyTimeoutMs !== undefined) bodyTimer = setTimeout(() => expire('BODY_TIMEOUT'), context.responseBodyTimeoutMs); },
    close() { clearTimeout(totalTimer); if (bodyTimer) clearTimeout(bodyTimer); caller.removeEventListener('abort', followTimeout); },
  };
}
/** Noncritical evidence cannot prevent saving a received provider response. */
export function transportEvidence(context: AdapterContext, event: Omit<TransportRunEvidence, 'at'>): void {
  try { context.onRunEvidence?.({ at: context.now().toISOString(), ...event }); } catch { /* Original operation remains authoritative. */ }
}
