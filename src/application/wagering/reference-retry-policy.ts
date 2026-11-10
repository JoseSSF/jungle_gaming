import { exponentialDelayMs } from '../../domain/shared/backoff';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';

export interface ReferenceRetryConfig {
  /** First re-check delay. */
  baseDelayMs: number;
  /** Cap for the exponential backoff. */
  maxDelayMs: number;
  /** Number of unsuccessful worker checks before REFERENCE_NOT_FOUND. */
  maxAttempts: number;
  /** Hard time-to-live since the transaction was received. */
  ttlMs: number;
}

/**
 * Backoff for transactions waiting on an out-of-order reference.
 * Defaults (see config): 1s base, 60s cap, 12 attempts, 15 min TTL — a provider normally
 * delivers the referenced operation within seconds; 15 minutes covers broker
 * redeliveries/visibility timeouts with a wide margin, and stays well below the
 * typical provider reconciliation window.
 */
export class ReferenceRetryPolicy {
  constructor(readonly config: ReferenceRetryConfig) {}

  /** `attempt` = number of checks already failed (0 when the transaction is first parked). */
  nextCheckAt(now: Date, attempt: number): Date {
    return new Date(now.getTime() + exponentialDelayMs(this.config, attempt + 1));
  }

  /** True when the check being performed now is the last allowed one. */
  isExhausted(tx: WagerTransaction, now: Date): boolean {
    const attemptsAfterThisCheck = tx.referenceAttempts + 1;
    const age = now.getTime() - tx.createdAt.getTime();
    return attemptsAfterThisCheck >= this.config.maxAttempts || age >= this.config.ttlMs;
  }
}
