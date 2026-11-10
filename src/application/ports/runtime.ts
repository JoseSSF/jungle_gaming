export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** Time-ordered unique id (UUIDv7). */
  next(): string;
}

export type LogFields = Record<string, string | number | boolean | null | undefined>;

/**
 * Structured logger. Request/message context (correlationId, messageId, ...) is
 * attached automatically by the implementation. Never log monetary payloads.
 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export type TransactionSource = 'http' | 'sqs' | 'worker' | 'internal';

export type DuplicateKind = 'idempotency-replay' | 'inbox-message' | 'outbox-redelivery';

export type ConflictReason =
  | 'lock-timeout'
  | 'deadlock'
  | 'serialization'
  | 'unique-race'
  | 'version-mismatch';

/** Business metrics port (implemented with Prometheus). */
export interface WageringMetrics {
  transactionCompleted(kind: string, status: string, source: TransactionSource): void;
  duplicateDetected(kind: DuplicateKind, source: TransactionSource): void;
  idempotencyConflict(source: TransactionSource): void;
  retry(operation: string, reason: string): void;
  concurrencyConflict(reason: ConflictReason): void;
  lockWaitSeconds(seconds: number): void;
  processingSeconds(source: TransactionSource, outcome: string, seconds: number): void;
  pendingReferenceResolution(outcome: string): void;
  reconciliation(consistent: boolean): void;
  outboxPublished(eventType: string, lagSeconds: number): void;
  outboxPublishFailed(eventType: string): void;
  outboxBacklog(pending: number, oldestAgeSeconds: number): void;
}

/**
 * Crash points used by the failure tests (worker killed after commit, before ack, ...).
 * The production implementation is a no-op unless FAULT_INJECTION is set explicitly.
 */
export type FaultPoint =
  | 'consumer-after-commit-before-ack'
  | 'outbox-after-claim'
  | 'outbox-after-publish-before-commit';

export interface FaultInjector {
  trigger(point: FaultPoint): void;
}
