import { MikroORM } from '@mikro-orm/postgresql';
import { PublishOutboxUseCase } from '../../src/application/use-cases/publish-outbox.use-case';
import { loadConfig } from '../../src/config/app-config';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { SqsQueues } from '../../src/infrastructure/messaging/sqs-queues';
import { buildOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { noFaults, systemClock } from '../../src/infrastructure/runtime';
import { scalar } from './database';
import { testEnv, uniqueQueues } from './env';
import { noopMetrics, silentLogger } from './in-memory-repositories';
import { testSqsClient } from './sqs';

/**
 * Publishes every pending outbox row (left by previous test files) to a scratch queue, so a
 * test can reason about "its" events only. Returns the number of published rows afterwards.
 */
export async function flushOutbox(): Promise<number> {
  const config = loadConfig(testEnv(uniqueQueues('scratch')));
  const queues = new SqsQueues(testSqsClient(), config.sqs);
  await queues.ensure();
  const orm = await MikroORM.init(buildOrmConfig(config));
  try {
    const relay = new PublishOutboxUseCase(
      new MikroOrmUnitOfWork(orm),
      new SqsEventPublisher(testSqsClient(), queues),
      systemClock,
      noopMetrics,
      silentLogger,
      noFaults,
      { batchSize: 10, backoff: { baseDelayMs: 100, maxDelayMs: 100 } },
    );
    while ((await relay.publishOnce()) > 0) {
      // drain
    }
  } finally {
    await orm.close(true);
  }
  return scalar<number>('SELECT COUNT(*)::int FROM outbox_messages WHERE published_at IS NOT NULL');
}
