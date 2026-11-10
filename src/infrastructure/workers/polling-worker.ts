import type { Logger } from '../../application/ports/runtime';
import { sleep } from '../../application/support/retry';
import { exponentialDelayMs } from '../../domain/shared/backoff';

export interface PollingWorkerOptions {
  name: string;
  intervalMs: number;
  /** Returns true when it did work (the next tick runs immediately). */
  tick(): Promise<boolean>;
}

/**
 * Minimal scheduler for background loops (outbox relay, pending references).
 * One tick at a time per instance; errors back off exponentially; stop() waits for the
 * current tick so that no SQL transaction is cut in the middle by a graceful shutdown.
 */
export class PollingWorker {
  private running = false;
  private loopPromise: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly options: PollingWorkerOptions,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
    this.logger.info('worker_started', { worker: this.options.name });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    await this.loopPromise;
    this.logger.info('worker_stopped', { worker: this.options.name });
  }

  private async loop(): Promise<void> {
    let failures = 0;
    while (this.running) {
      let didWork = false;
      try {
        didWork = await this.options.tick();
        failures = 0;
      } catch (error) {
        failures += 1;
        this.logger.warn('worker_tick_failed', {
          worker: this.options.name,
          failures,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!this.running) break;
      if (didWork) continue;
      const delay =
        failures > 0
          ? exponentialDelayMs({ baseDelayMs: this.options.intervalMs, maxDelayMs: 30_000 }, failures)
          : this.options.intervalMs;
      await this.interruptibleSleep(delay);
    }
  }

  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = undefined;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
    });
  }
}

export { sleep };
