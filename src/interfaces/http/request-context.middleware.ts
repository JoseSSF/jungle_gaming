import type { NextFunction, Request, Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import type { Logger } from '../../application/ports/runtime';
import type { AppMetrics } from '../../infrastructure/observability/metrics';
import { runWithContext } from '../../infrastructure/observability/request-context';

const CORRELATION_HEADER = 'x-correlation-id';
const CORRELATION_PATTERN = /^[A-Za-z0-9._:\-]{1,128}$/;

/**
 * Step 1 (before the body parser): resolves the correlationId — propagated from
 * X-Correlation-Id or generated — and echoes it, so even body-parse errors carry it.
 */
export function correlationIdMiddleware() {
  return (request: Request, response: Response, next: NextFunction): void => {
    const incoming = request.header(CORRELATION_HEADER);
    const correlationId = incoming && CORRELATION_PATTERN.test(incoming) ? incoming : uuidv7();
    response.locals.correlationId = correlationId;
    response.setHeader('X-Correlation-Id', correlationId);
    next();
  };
}

/**
 * Step 2 (after the body parser, whose async stream callbacks would otherwise escape the
 * scope): opens the async logging scope and records request metrics/logs on completion.
 * Bodies are never logged.
 */
export function requestContextMiddleware(logger: Logger, metrics: AppMetrics) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const correlationId = String(response.locals.correlationId ?? uuidv7());
    const started = performance.now();

    runWithContext({ correlationId }, () => {
      response.on('finish', () => {
        const route = (request.route as { path?: string } | undefined)?.path ?? 'unmatched';
        const seconds = (performance.now() - started) / 1000;
        metrics.httpRequests.observe(
          { method: request.method, route: `${request.baseUrl ?? ''}${route}`, status: String(response.statusCode) },
          seconds,
        );
        if (!request.path.startsWith('/health') && request.path !== '/metrics') {
          logger.info('http_request', {
            method: request.method,
            route,
            status: response.statusCode,
            durationMs: Math.round(seconds * 1000),
          });
        }
      });
      next();
    });
  };
}
