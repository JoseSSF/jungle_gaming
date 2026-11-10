import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Logger } from '../../application/ports/runtime';
import type { PublishOutboxUseCase } from '../../application/use-cases/publish-outbox.use-case';
import type { ResolvePendingReferencesUseCase } from '../../application/use-cases/resolve-pending-references.use-case';
import { TOKENS } from '../../app.tokens';
import type { AppConfig } from '../../config/app-config';
import type { SqsQueues } from '../messaging/sqs-queues';
import type { WagerTransactionConsumer } from '../messaging/wager-transaction-consumer';
import { PollingWorker } from './polling-worker';

/**
 * Starts the background roles enabled in WORKERS (consumer, outbox, pending-references)
 * and stops them gracefully on SIGTERM, before the ORM connection pool is closed.
 * Every role is safe to run on any number of instances at the same time.
 */
@Injectable()
export class WorkersService implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly workers: PollingWorker[] = [];

  constructor(
    @Inject(TOKENS.config) private readonly config: AppConfig,
    @Inject(TOKENS.logger) private readonly logger: Logger,
    @Inject(TOKENS.orm) private readonly orm: MikroORM,
    @Inject(TOKENS.sqsQueues) private readonly queues: SqsQueues,
    @Inject(TOKENS.consumer) private readonly consumer: WagerTransactionConsumer,
    @Inject(TOKENS.publishOutbox) private readonly publishOutbox: PublishOutboxUseCase,
    @Inject(TOKENS.resolvePendingReferences) private readonly resolvePending: ResolvePendingReferencesUseCase,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.sqs.autoCreateQueues) {
      try {
        await this.queues.ensure();
      } catch (error) {
        // Readiness reports SQS down; workers keep retrying with backoff.
        this.logger.warn('sqs_queue_setup_failed', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    const roles = this.config.workers;
    if (roles.has('outbox')) {
      this.workers.push(
        new PollingWorker(
          {
            name: 'outbox-relay',
            intervalMs: this.config.outbox.pollIntervalMs,
            tick: async () => (await this.publishOutbox.publishOnce()) > 0,
          },
          this.logger,
        ),
        new PollingWorker(
          {
            name: 'outbox-lag-metrics',
            intervalMs: this.config.outbox.metricsIntervalMs,
            tick: async () => {
              await this.publishOutbox.refreshBacklogMetrics();
              return false;
            },
          },
          this.logger,
        ),
      );
    }
    if (roles.has('pending-references')) {
      this.workers.push(
        new PollingWorker(
          {
            name: 'pending-references',
            intervalMs: this.config.pendingReferences.pollIntervalMs,
            tick: async () => {
              const summary = await this.resolvePending.runOnce();
              return summary.examined > 0 && summary.examined > summary.skipped;
            },
          },
          this.logger,
        ),
      );
    }
    for (const worker of this.workers) worker.start();
    if (roles.has('consumer')) this.consumer.start();
    this.logger.info('workers_bootstrapped', { workers: [...roles].join(',') || 'none' });
  }

  /** SIGTERM: stop consuming first (finish/return in-flight messages), then the loops. */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.logger.info('shutdown_started', { signal: signal ?? 'none' });
    await this.consumer.stop();
    await Promise.all(this.workers.map((worker) => worker.stop()));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
    this.logger.info('shutdown_completed');
  }
}
