import type { ConflictReason } from './ports/runtime';

/**
 * Error categories drive the transport mapping:
 *  - HTTP: validation 400, unauthorized 401, forbidden 403, not-found 404,
 *          conflict 409, transient 503, permanent 500.
 *  - SQS:  validation/conflict/permanent → DLQ, transient → retry with backoff.
 */
export type ErrorCategory =
  | 'validation'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'transient'
  | 'permanent';

export interface ErrorIssue {
  path: string;
  message: string;
}

export abstract class ApplicationError extends Error {
  abstract readonly category: ErrorCategory;

  protected constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }

  get retryable(): boolean {
    return this.category === 'transient';
  }
}

/** Invalid payload / contract violation. Never retryable as-is. */
export class InvalidCommandError extends ApplicationError {
  readonly category = 'validation';

  constructor(
    code: string,
    message: string,
    readonly issues: readonly ErrorIssue[] = [],
  ) {
    super(code, message);
  }
}

export class NotFoundError extends ApplicationError {
  readonly category = 'not-found';

  constructor(code: string, message: string) {
    super(code, message);
  }
}

/** Same idempotency key (or external id) reused with a different payload. */
export class IdempotencyConflictError extends ApplicationError {
  readonly category = 'conflict';

  constructor(
    code: 'IDEMPOTENCY_KEY_CONFLICT' | 'EXTERNAL_TRANSACTION_ID_CONFLICT',
    message: string,
    readonly existingTransactionId: string,
  ) {
    super(code, message);
  }
}

/** Same broker messageId delivered with a different payload (producer bug). */
export class InboxConflictError extends ApplicationError {
  readonly category = 'conflict';

  constructor(messageId: string) {
    super('INBOX_MESSAGE_CONFLICT', `Message ${messageId} was already consumed with a different payload`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly category = 'conflict';

  constructor(playerId: string, currency: string, options?: { cause?: unknown }) {
    super('WALLET_ALREADY_EXISTS', `A ${currency} wallet already exists for player ${playerId}`, options);
  }
}

export class UnauthorizedError extends ApplicationError {
  readonly category = 'unauthorized';

  constructor(message = 'Missing or invalid access token') {
    super('UNAUTHORIZED', message);
  }
}

export class ForbiddenError extends ApplicationError {
  readonly category = 'forbidden';

  constructor(code = 'FORBIDDEN', message = 'Not allowed') {
    super(code, message);
  }
}

/**
 * Lost race on a row lock / unique key / version guard. The whole SQL transaction was
 * rolled back, so retrying it is always safe. Retried in-process with backoff first.
 */
export class ConcurrencyConflictError extends ApplicationError {
  readonly category = 'transient';

  constructor(
    readonly reason: ConflictReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super('CONCURRENCY_CONFLICT', message, options);
  }
}

/** PostgreSQL / SQS unreachable, timeouts, too many connections... */
export class InfrastructureUnavailableError extends ApplicationError {
  readonly category = 'transient';

  constructor(message: string, options?: { cause?: unknown }) {
    super('SERVICE_UNAVAILABLE', message, options);
  }
}

/**
 * Database refused a write because an invariant enforced by the schema would break
 * (CHECK, FK, trigger). Indicates a bug or corrupted input — never retried.
 */
export class PersistenceInvariantError extends ApplicationError {
  readonly category = 'permanent';

  constructor(
    readonly constraint: string | undefined,
    message: string,
    options?: { cause?: unknown },
  ) {
    super('PERSISTENCE_INVARIANT_VIOLATION', message, options);
  }
}

/** Unexpected permanent failure while processing; the transaction was recorded as FAILED. */
export class ProcessingFailedError extends ApplicationError {
  readonly category = 'permanent';

  constructor(
    message: string,
    readonly transactionId: string | undefined,
    options?: { cause?: unknown },
  ) {
    super('PROCESSING_FAILED', message, options);
  }
}
