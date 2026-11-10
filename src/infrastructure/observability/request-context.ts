import { AsyncLocalStorage } from 'node:async_hooks';

/** Correlation fields attached to every log line emitted inside a request/message scope. */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export function runWithContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...context }, fn);
}

/** Adds fields to the current scope (no-op outside of a scope). */
export function enrichContext(fields: LogContext): void {
  const store = storage.getStore();
  if (!store) return;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) (store as Record<string, unknown>)[key] = value;
  }
}

export function currentContext(): LogContext {
  return storage.getStore() ?? {};
}
