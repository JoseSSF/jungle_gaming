import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { UnitOfWork } from './application/ports/repositories';
import type { Clock, FaultInjector, IdGenerator } from './application/ports/runtime';
import { CreateWalletUseCase } from './application/use-cases/create-wallet.use-case';
import { PublishOutboxUseCase } from './application/use-cases/publish-outbox.use-case';
import { ReconcileWalletUseCase } from './application/use-cases/reconcile-wallet.use-case';
import { ResolvePendingReferencesUseCase } from './application/use-cases/resolve-pending-references.use-case';
import { SubmitWagerTransactionUseCase } from './application/use-cases/submit-wager-transaction.use-case';
import { WageringQueries } from './application/use-cases/wagering-queries';
import { ReferenceRetryPolicy } from './application/wagering/reference-retry-policy';
import { WagerTransactionProcessor } from './application/wagering/wager-transaction-processor';
import { TOKENS } from './app.tokens';
import type { AppConfig } from './config/app-config';
import { type AccessTokenVerifier, JwtAccessTokenVerifier } from './infrastructure/auth/access-token-verifier';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event-publisher';
import { createSqsClient, SqsQueues } from './infrastructure/messaging/sqs-queues';
import { WagerTransactionConsumer } from './infrastructure/messaging/wager-transaction-consumer';
import type { AppLogger } from './infrastructure/observability/logger';
import { AppMetrics } from './infrastructure/observability/metrics';
import { buildOrmConfig } from './infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { EnvFaultInjector, systemClock, uuidV7Generator } from './infrastructure/runtime';
import { WorkersService } from './infrastructure/workers/workers.service';
import { AuthGuard } from './interfaces/http/auth.guard';
import { HealthController, HealthService, MetricsController } from './interfaces/http/health.controller';
import { HttpErrorFilter } from './interfaces/http/http-error.filter';
import { WageringController } from './interfaces/http/wagering.controller';
import { WalletsController } from './interfaces/http/wallets.controller';

export interface AppModuleOptions {
  config: AppConfig;
  logger: AppLogger;
  metrics: AppMetrics;
  /** Test hook: replaces the JWKS-based verifier. */
  tokenVerifier?: AccessTokenVerifier;
}

const factory = <T>(provide: symbol, inject: symbol[], useFactory: (...args: never[]) => T): Provider => ({
  provide,
  inject,
  useFactory: useFactory as (...args: unknown[]) => T,
});

/**
 * Composition root. The domain and application layers are plain TypeScript; NestJS only
 * wires them (factories) and hosts the HTTP/worker adapters.
 */
@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    const { config } = options;
    return {
      module: AppModule,
      controllers: [WalletsController, WageringController, HealthController, MetricsController],
      providers: [
        { provide: TOKENS.config, useValue: config },
        { provide: TOKENS.logger, useValue: options.logger },
        { provide: TOKENS.metrics, useValue: options.metrics },
        { provide: TOKENS.clock, useValue: systemClock },
        { provide: TOKENS.ids, useValue: uuidV7Generator },
        { provide: TOKENS.faults, useValue: new EnvFaultInjector(config.faultInjection, options.logger) },
        { provide: TOKENS.orm, useFactory: () => MikroORM.init(buildOrmConfig(config)) },
        factory(TOKENS.unitOfWork, [TOKENS.orm], (orm: MikroORM) => new MikroOrmUnitOfWork(orm)),
        { provide: TOKENS.sqsClient, useFactory: () => createSqsClient(config) },
        factory(TOKENS.sqsQueues, [TOKENS.sqsClient], (sqs: SQSClient) => new SqsQueues(sqs, config.sqs)),
        {
          provide: TOKENS.tokenVerifier,
          useValue:
            options.tokenVerifier ??
            new JwtAccessTokenVerifier({ issuer: config.auth.issuer, audience: config.auth.audience, keys: config.auth.jwksUrl }),
        },
        factory(
          TOKENS.processor,
          [TOKENS.ids],
          (ids: IdGenerator) =>
            new WagerTransactionProcessor(
              ids,
              new ReferenceRetryPolicy({
                baseDelayMs: config.pendingReferences.baseDelayMs,
                maxDelayMs: config.pendingReferences.maxDelayMs,
                maxAttempts: config.pendingReferences.maxAttempts,
                ttlMs: config.pendingReferences.ttlMs,
              }),
            ),
        ),
        factory(
          TOKENS.submitWager,
          [TOKENS.unitOfWork, TOKENS.processor, TOKENS.ids, TOKENS.clock],
          (uow: UnitOfWork, processor: WagerTransactionProcessor, ids: IdGenerator, clock: Clock) =>
            new SubmitWagerTransactionUseCase(uow, processor, ids, clock, options.metrics, options.logger, {
              lockTimeoutMs: config.database.walletLockTimeoutMs,
              maxConflictRetries: config.database.maxConflictRetries,
            }),
        ),
        factory(
          TOKENS.createWallet,
          [TOKENS.unitOfWork, TOKENS.ids, TOKENS.clock],
          (uow: UnitOfWork, ids: IdGenerator, clock: Clock) =>
            new CreateWalletUseCase(uow, ids, clock, options.metrics, options.logger),
        ),
        factory(
          TOKENS.reconcileWallet,
          [TOKENS.unitOfWork, TOKENS.clock],
          (uow: UnitOfWork, clock: Clock) => new ReconcileWalletUseCase(uow, clock, options.metrics, options.logger),
        ),
        factory(TOKENS.queries, [TOKENS.unitOfWork], (uow: UnitOfWork) => new WageringQueries(uow)),
        factory(
          TOKENS.publishOutbox,
          [TOKENS.unitOfWork, TOKENS.sqsClient, TOKENS.sqsQueues, TOKENS.clock, TOKENS.faults],
          (uow: UnitOfWork, sqs: SQSClient, queues: SqsQueues, clock: Clock, faults: FaultInjector) =>
            new PublishOutboxUseCase(uow, new SqsEventPublisher(sqs, queues), clock, options.metrics, options.logger, faults, {
              batchSize: config.outbox.batchSize,
              backoff: { baseDelayMs: config.outbox.backoffBaseMs, maxDelayMs: config.outbox.backoffMaxMs },
            }),
        ),
        factory(
          TOKENS.resolvePendingReferences,
          [TOKENS.unitOfWork, TOKENS.processor, TOKENS.ids, TOKENS.clock],
          (uow: UnitOfWork, processor: WagerTransactionProcessor, ids: IdGenerator, clock: Clock) =>
            new ResolvePendingReferencesUseCase(uow, processor, ids, clock, options.metrics, options.logger, {
              batchSize: config.pendingReferences.batchSize,
              lockTimeoutMs: config.database.walletLockTimeoutMs,
              maxConflictRetries: config.database.maxConflictRetries,
            }),
        ),
        factory(
          TOKENS.consumer,
          [TOKENS.sqsClient, TOKENS.sqsQueues, TOKENS.submitWager, TOKENS.faults],
          (sqs: SQSClient, queues: SqsQueues, submit: SubmitWagerTransactionUseCase, faults: FaultInjector) =>
            new WagerTransactionConsumer(sqs, queues, submit, config.sqs, options.metrics, options.logger, faults),
        ),
        HealthService,
        WorkersService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: HttpErrorFilter },
      ],
    };
  }
}
