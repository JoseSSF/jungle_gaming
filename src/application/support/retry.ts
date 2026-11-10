import { type ExponentialBackoff, exponentialDelayMs } from '../../domain/shared/backoff';

export interface RetryOptions extends ExponentialBackoff {
  maxAttempts: number;
  isRetryable(error: unknown): boolean;
  onRetry?(error: unknown, attempt: number, delayMs: number): void;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bounded retry with capped exponential backoff and full jitter. Only for operations
 * that are safe to repeat (a rolled-back SQL transaction is).
 */
export async function withRetry<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= options.maxAttempts || !options.isRetryable(error)) throw error;
      const cap = exponentialDelayMs(options, attempt);
      const delay = Math.floor(Math.random() * cap) + 1;
      options.onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }
}
