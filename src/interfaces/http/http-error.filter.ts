import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import type { Response } from 'express';
import { ApplicationError, type ErrorCategory, IdempotencyConflictError, InvalidCommandError, ProcessingFailedError } from '../../application/errors';
import type { Logger } from '../../application/ports/runtime';
import { TOKENS } from '../../app.tokens';
import { FAILURE_CODE_ACTIONS, FailureCode } from '../../domain/wagering/failure-code';
import { currentContext } from '../../infrastructure/observability/request-context';

const STATUS_BY_CATEGORY: Record<ErrorCategory, number> = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  'not-found': 404,
  conflict: 409,
  transient: 503,
  permanent: 500,
};

/**
 * Single error contract for every endpoint:
 *   { "error": { "code", "message", "retryable", ...details }, "correlationId" }
 *
 *   400 invalid payload          (fix the request; do not retry as-is)
 *   401/403 authentication/authorization
 *   404 resource not found
 *   409 idempotency conflict     (same key, different payload — never a replay)
 *   422 business rejection       (returned by the submit endpoint with a failureCode)
 *   202 accepted, pending        (PENDING_REFERENCE)
 *   503 transient infrastructure (safe to retry with the SAME Idempotency-Key; Retry-After)
 *   500 permanent failure        (do not retry; contact operator)
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(@Inject(TOKENS.logger) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, error } = this.map(exception);
    if (status === 503) response.setHeader('Retry-After', '1');
    if (status >= 500) {
      this.logger.error('http_request_failed', {
        status,
        code: String(error.code),
        error: exception instanceof Error ? exception.message : String(exception),
      });
    }
    const correlationId = currentContext().correlationId ?? (response.locals.correlationId as string | undefined) ?? null;
    response.status(status).json({ error, correlationId });
  }

  private map(exception: unknown): { status: number; error: Record<string, unknown> } {
    if (exception instanceof ApplicationError) {
      const error: Record<string, unknown> = {
        code: exception.code,
        message: exception.message,
        retryable: exception.retryable,
      };
      if (exception instanceof InvalidCommandError && exception.issues.length > 0) error.issues = exception.issues;
      if (exception instanceof IdempotencyConflictError) error.existingTransactionId = exception.existingTransactionId;
      if (exception instanceof ProcessingFailedError) {
        error.transactionId = exception.transactionId ?? null;
        error.failureCode = FailureCode.ProcessingFailed;
        error.providerAction = FAILURE_CODE_ACTIONS[FailureCode.ProcessingFailed];
      }
      return { status: STATUS_BY_CATEGORY[exception.category], error };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code =
        status === 404
          ? 'ROUTE_NOT_FOUND'
          : status === 413
            ? 'PAYLOAD_TOO_LARGE'
            : status === 400
              ? 'INVALID_JSON'
              : `HTTP_${status}`;
      return { status, error: { code, message: exception.message, retryable: false } };
    }
    return { status: 500, error: { code: 'INTERNAL_ERROR', message: 'Unexpected error', retryable: false } };
  }
}
