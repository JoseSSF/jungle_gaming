import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import type { AppConfig } from './config/app-config';
import type { AccessTokenVerifier } from './infrastructure/auth/access-token-verifier';
import { type AppLogger, createLogger, NestLoggerAdapter } from './infrastructure/observability/logger';
import { AppMetrics } from './infrastructure/observability/metrics';
import { correlationIdMiddleware, requestContextMiddleware } from './interfaces/http/request-context.middleware';

export interface StartedApp {
  app: INestApplication;
  config: AppConfig;
  logger: AppLogger;
  metrics: AppMetrics;
  url: string;
  close(): Promise<void>;
}

export interface CreateAppOptions {
  logger?: AppLogger;
  tokenVerifier?: AccessTokenVerifier;
  /** Install SIGTERM/SIGINT handlers (true for the real process, false in tests). */
  shutdownHooks?: boolean;
}

export async function createApp(config: AppConfig, options: CreateAppOptions = {}): Promise<StartedApp> {
  const logger = options.logger ?? createLogger({ level: config.logLevel, instanceId: config.instanceId });
  const metrics = new AppMetrics({ instanceId: config.instanceId });

  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot({ config, logger, metrics, tokenVerifier: options.tokenVerifier }),
    { logger: new NestLoggerAdapter(logger), bodyParser: false },
  );
  app.disable('x-powered-by');
  app.use(correlationIdMiddleware());
  // Body parser before the async scope: its stream callbacks would otherwise escape it.
  app.useBodyParser('json', { limit: '64kb' });
  app.use(requestContextMiddleware(logger, metrics));
  if (options.shutdownHooks !== false) app.enableShutdownHooks(['SIGTERM', 'SIGINT']);

  await app.listen(config.port, '0.0.0.0');
  const address = app.getHttpServer().address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const url = `http://127.0.0.1:${port}`;
  logger.info('application_started', { port, workers: [...config.workers].join(',') || 'none' });

  return { app, config, logger, metrics, url, close: () => app.close() };
}
