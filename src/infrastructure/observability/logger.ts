import type { LoggerService } from '@nestjs/common';
import pino, { type Logger as PinoInstance } from 'pino';
import type { LogFields, Logger } from '../../application/ports/runtime';
import { currentContext } from './request-context';

/**
 * Keys that must never reach the logs, wherever they appear. Application code already
 * avoids logging monetary payloads; redaction is the safety net.
 */
const REDACTED_PATHS = [
  'money',
  'amount',
  'balance',
  'balanceBefore',
  'balanceAfter',
  'initialBalance',
  'payload',
  'body',
  'authorization',
  'token',
  'accessToken',
  'password',
  'secret',
  '*.money',
  '*.amount',
  '*.balance',
  '*.payload',
  '*.authorization',
  '*.password',
  'req.headers.authorization',
];

export interface AppLogger extends Logger {
  readonly pino: PinoInstance;
  child(bindings: LogFields): AppLogger;
}

class PinoAppLogger implements AppLogger {
  constructor(readonly pino: PinoInstance) {}

  debug(message: string, fields?: LogFields): void {
    this.pino.debug(fields ?? {}, message);
  }

  info(message: string, fields?: LogFields): void {
    this.pino.info(fields ?? {}, message);
  }

  warn(message: string, fields?: LogFields): void {
    this.pino.warn(fields ?? {}, message);
  }

  error(message: string, fields?: LogFields): void {
    this.pino.error(fields ?? {}, message);
  }

  child(bindings: LogFields): AppLogger {
    return new PinoAppLogger(this.pino.child(bindings));
  }
}

export function createLogger(options: { level: string; instanceId: string; service?: string }): AppLogger {
  const instance = pino({
    level: options.level,
    base: { service: options.service ?? 'wagering-processor', instanceId: options.instanceId },
    messageKey: 'msg',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    // correlationId / messageId / transactionId / walletId / providerId from the async scope.
    mixin: () => ({ ...currentContext() }),
  });
  return new PinoAppLogger(instance);
}

/** Adapter so NestJS internal logs are also structured JSON. */
export class NestLoggerAdapter implements LoggerService {
  constructor(private readonly logger: AppLogger) {}

  log(message: unknown, ...optional: unknown[]): void {
    this.logger.info(String(message), contextOf(optional));
  }

  error(message: unknown, ...optional: unknown[]): void {
    this.logger.error(String(message), contextOf(optional));
  }

  warn(message: unknown, ...optional: unknown[]): void {
    this.logger.warn(String(message), contextOf(optional));
  }

  debug(message: unknown, ...optional: unknown[]): void {
    this.logger.debug(String(message), contextOf(optional));
  }

  verbose(message: unknown, ...optional: unknown[]): void {
    this.logger.debug(String(message), contextOf(optional));
  }
}

function contextOf(optional: unknown[]): LogFields {
  const last = optional.at(-1);
  return typeof last === 'string' ? { context: last } : {};
}
