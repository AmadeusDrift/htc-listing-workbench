import { abortable } from './protocol.ts';
import { MiaoshouError } from './validation.ts';

export interface MiaoshouRateClock { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> }
// Conservative client defaults, not advertised provider quotas. Shared by list and detail reads.
export const MIAOSHOU_READ_POLICY = { intervalMs: 1200, attempts: 3, maximumAutomaticWaitMs: 60000 } as const;
const clock: MiaoshouRateClock = {
  now: () => performance.now(),
  sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  }),
};

/** A bounded service queue owns this scheduler; retries and cooldowns remain shared across products. */
export class MiaoshouReadScheduler {
  private tail: Promise<void> = Promise.resolve();
  private nextStart = 0;
  private cooldownUntil = 0;
  private cooldownError?: MiaoshouError;
  private clock: MiaoshouRateClock;
  constructor(customClock?: MiaoshouRateClock) { this.clock = customClock ?? clock; }
  run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const task = this.tail.then(() => this.execute(operation, signal));
    this.tail = task.then(() => {}, () => {});
    // A cancelled queued caller settles immediately; its queue slot later skips without sending anything.
    return abortable(task, signal);
  }
  private check(signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason instanceof MiaoshouError ? signal.reason : new MiaoshouError('CHANGED');
  }
  private async wait(signal: AbortSignal): Promise<void> {
    for (;;) {
      this.check(signal);
      const now = this.clock.now(), cooldown = this.cooldownUntil - now;
      if (cooldown > MIAOSHOU_READ_POLICY.maximumAutomaticWaitMs || cooldown > 0 && this.cooldownError?.rateLimit?.window === 'day') throw this.cooldownError;
      const delay = Math.max(this.nextStart, this.cooldownUntil) - now;
      if (delay <= 0) return;
      await this.clock.sleep(delay, signal);
    }
  }
  private async execute<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      await this.wait(signal); this.check(signal);
      this.nextStart = this.clock.now() + MIAOSHOU_READ_POLICY.intervalMs;
      try { return await operation(); }
      catch (error) {
        this.check(signal);
        if (!(error instanceof MiaoshouError) || error.code !== 'LIMIT') throw error;
        const window = error.rateLimit?.window ?? 'unknown';
        const fallback = window === 'day' ? 24 * 60 * 60_000 : window === 'minute' ? 60000 : 3000 * 2 ** (attempt - 1);
        const delay = Math.max(fallback, error.rateLimit?.retryAfterMs ?? 0);
        this.cooldownUntil = Math.max(this.cooldownUntil, this.clock.now() + delay); this.cooldownError = error;
        if (attempt >= MIAOSHOU_READ_POLICY.attempts || window === 'day' || delay > MIAOSHOU_READ_POLICY.maximumAutomaticWaitMs) throw error;
      }
    }
  }
}
