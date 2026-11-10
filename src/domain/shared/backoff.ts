export interface ExponentialBackoff {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/**
 * Deterministic capped exponential backoff: base * 2^(attempt-1), capped at max.
 * `attempt` is 1-based (first retry = attempt 1). Jitter, when wanted, is added by callers.
 */
export function exponentialDelayMs(policy: ExponentialBackoff, attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  // Cap the exponent to avoid Infinity for very large attempt counts.
  const raw = policy.baseDelayMs * 2 ** Math.min(exponent, 30);
  return Math.min(policy.maxDelayMs, raw);
}
