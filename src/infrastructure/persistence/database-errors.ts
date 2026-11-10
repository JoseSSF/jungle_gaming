import {
  ApplicationError,
  ConcurrencyConflictError,
  InfrastructureUnavailableError,
  PersistenceInvariantError,
} from '../../application/errors';
import { DomainError } from '../../domain/shared/domain-error';

interface DriverErrorShape {
  code?: unknown;
  constraint?: unknown;
  name?: unknown;
  message?: unknown;
  cause?: unknown;
}

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EPIPE',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '53400', // configuration_limit_exceeded
  '57014', // query_canceled (statement_timeout)
  '25006', // read_only_sql_transaction (failover)
]);

const INVARIANT_ERROR_CODES = new Set([
  '23000', // integrity_constraint_violation (our triggers)
  '23001', // restrict_violation
  '23502', // not_null_violation
  '23503', // foreign_key_violation
  '23514', // check_violation
  '22003', // numeric_value_out_of_range
  '22P02', // invalid_text_representation
  'P0001', // raise_exception
]);

function fieldsOf(error: unknown): DriverErrorShape {
  return error !== null && typeof error === 'object' ? (error as DriverErrorShape) : {};
}

/** Walks `cause` chains to find the first error carrying a SQLSTATE / errno. */
function findCode(error: unknown, depth = 0): { code?: string; constraint?: string } {
  const fields = fieldsOf(error);
  if (typeof fields.code === 'string') {
    return { code: fields.code, constraint: typeof fields.constraint === 'string' ? fields.constraint : undefined };
  }
  if (depth < 5 && fields.cause) return findCode(fields.cause, depth + 1);
  return {};
}

export function constraintOf(error: unknown): string | undefined {
  return findCode(error).constraint;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const found = findCode(error);
  return found.code === '23505' && (constraint === undefined || found.constraint === constraint);
}

/**
 * Translates driver/ORM errors into application errors. Application and domain errors pass
 * through untouched. Unknown errors are returned as-is (they surface as 500 / DLQ).
 */
export function translateDatabaseError(error: unknown): unknown {
  if (error instanceof ApplicationError || error instanceof DomainError) return error;
  const { code, constraint } = findCode(error);
  const name = String(fieldsOf(error).name ?? '');
  const message = String(fieldsOf(error).message ?? 'database error');

  switch (code) {
    case '55P03':
      return new ConcurrencyConflictError('lock-timeout', 'Timed out waiting for a row lock', { cause: error });
    case '40P01':
      return new ConcurrencyConflictError('deadlock', 'Deadlock detected', { cause: error });
    case '40001':
      return new ConcurrencyConflictError('serialization', 'Serialization failure', { cause: error });
    case '23505':
      return new ConcurrencyConflictError('unique-race', `Unique constraint ${constraint ?? '?'} raced`, { cause: error });
  }
  if (code && INVARIANT_ERROR_CODES.has(code)) {
    return new PersistenceInvariantError(constraint, `Database invariant violated (${code}${constraint ? ` ${constraint}` : ''}): ${message}`, {
      cause: error,
    });
  }
  if (
    (code && (CONNECTION_ERROR_CODES.has(code) || code.startsWith('08'))) ||
    name === 'KnexTimeoutError' ||
    name === 'ConnectionException' ||
    /Connection terminated|connect ECONNREFUSED|Timeout acquiring a connection|Client has encountered a connection error/i.test(message)
  ) {
    return new InfrastructureUnavailableError('Database unavailable', { cause: error });
  }
  return error;
}
