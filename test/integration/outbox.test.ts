import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import type { EventPublisher, PublishResult } from '../../src/application/ports/event-publisher';
import { PublishOutboxUseCase } from '../../src/application/use-cases/publish-outbox.use-case';
import { loadConfig } from '../../src/config/app-config';
import type { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { SqsQueues } from '../../src/infrastructure/messaging/sqs-queues';
import { buildOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { noFaults, systemClock } from '../../src/infrastructure/runtime';
import { wagerPayload } from '../support/api';
import { startApp } from '../support/app';
import { db, prepareDatabase } from '../support/database';
import { type Env, sleep, testEnv, uniqueQueues } from '../support/env';
import { noopMetrics, silentLogger } from '../support/in-memory-repositories';
import { assertGlobalInvariants } from '../support/invariants';
import { drain, ensureQueues, testSqsClient } from '../support/sqs';

const env: Env = { ...uniqueQueues('outbox') };
let app: Awaited<ReturnType<typeof startApp>>;
let queues: { main: string; dlq: string; events: string };
const orms: MikroORM[] = [];

/** Records which publisher sent which event, delegating to the real SQS publisher. */
class RecordingPublisher implements EventPublisher {
  readonly published: string[] = [];

  constructor(private readonly inner: EventPublisher) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishResult> {
    const result = await this.inner.publish(messages);
    this.published.push(...result.succeeded);
    return result;
  }
}

const brokenBroker: EventPublisher = {
  publish: async () => {
    throw new Error('broker unavailable');
  },
};

/** A publisher "instance": its own connection pool, like a separate process. */
async function publisherInstance(publisher: EventPublisher): Promise<PublishOutboxUseCase> {
  const config = loadConfig(testEnv(env));
  const orm = await MikroORM.init(buildOrmConfig(config));
  orms.push(orm);
  return new PublishOutboxUseCase(new MikroOrmUnitOfWork(orm), publisher, systemClock, noopMetrics, silentLogger, noFaults, {
    batchSize: 5,
    backoff: { baseDelayMs: 300, maxDelayMs: 300 },
  });
}

function sqsPublisher(): SqsEventPublisher {
  const config = loadConfig(testEnv(env));
  return new SqsEventPublisher(testSqsClient(), new SqsQueues(testSqsClient(), config.sqs));
}

async function pendingEventIdsFor(walletIds: string[]): Promise<string[]> {
  const result = await db().query(
    `SELECT id FROM outbox_messages WHERE published_at IS NULL AND payload->'data'->>'walletId' = ANY($1)`,
    [walletIds],
  );
  return result.rows.map((row) => row.id as string);
}

async function createTraffic(): Promise<string[]> {
  const walletIds: string[] = [];
  for (let w = 0; w < 4; w += 1) {
    const { walletId, playerId } = await app.api.createWallet('100.00');
    walletIds.push(walletId);
    for (let i = 0; i < 5; i += 1) await app.api.submit(wagerPayload(walletId, playerId, { amount: '1.00' }));
  }
  return walletIds;
}

beforeAll(async () => {
  await prepareDatabase();
  queues = await ensureQueues(env);
  app = await startApp({ ...env, WORKERS: 'none' }); // no relay: events stay pending
});

afterAll(async () => {
  await app?.close();
  await Promise.all(orms.map((orm) => orm.close(true)));
  await assertGlobalInvariants();
});

describe('outbox relay', () => {
  test('events are committed with the state change and wait for the relay', async () => {
    const walletIds = await createTraffic();
    // 4 wallets × (opening: 2 events + 5 bets × 2 events) = 48
    expect(await pendingEventIdsFor(walletIds)).toHaveLength(48);
  });

  test('two concurrent publishers never publish the same row (FOR UPDATE SKIP LOCKED)', async () => {
    const walletIds = await createTraffic();
    const expected = new Set(await pendingEventIdsFor(walletIds));
    await drain(queues.events, 0);

    const recorderA = new RecordingPublisher(sqsPublisher());
    const recorderB = new RecordingPublisher(sqsPublisher());
    const [a, b] = await Promise.all([publisherInstance(recorderA), publisherInstance(recorderB)]);
    const loop = async (publisher: PublishOutboxUseCase) => {
      while ((await publisher.publishOnce()) > 0) {
        // keep draining
      }
    };
    await Promise.all([loop(a), loop(b), loop(a), loop(b)]);

    const fromA = new Set(recorderA.published);
    const fromB = new Set(recorderB.published);
    expect(recorderA.published.length).toBe(fromA.size);
    expect(recorderB.published.length).toBe(fromB.size);
    expect([...fromA].filter((id) => fromB.has(id))).toEqual([]); // no row published twice
    for (const id of expected) expect(fromA.has(id) || fromB.has(id)).toBe(true);
    expect(await pendingEventIdsFor(walletIds)).toEqual([]);

    const received = await drain(queues.events);
    const receivedIds = received.map((message) => JSON.parse(message.Body ?? '{}').eventId as string);
    for (const id of expected) expect(receivedIds).toContain(id);
    const sample = JSON.parse(received[0]?.Body ?? '{}');
    expect(sample).toMatchObject({ eventId: expect.any(String), eventType: expect.any(String), version: 1 });
  });

  test('broker failures are rescheduled with backoff and published later (nothing lost)', async () => {
    const walletIds = await createTraffic();
    const expected = await pendingEventIdsFor(walletIds);
    const failing = await publisherInstance(brokenBroker);
    while ((await failing.publishOnce()) > 0) {
      // every due row gets attempts++ and a future next_attempt_at
    }
    const attempts = await db().query(
      `SELECT attempts, next_attempt_at > now() AS deferred, last_error FROM outbox_messages WHERE id = ANY($1)`,
      [expected],
    );
    expect(attempts.rows.every((row) => row.attempts === 1 && row.deferred && String(row.last_error).includes('broker'))).toBe(true);

    const healthy = await publisherInstance(new RecordingPublisher(sqsPublisher()));
    expect(await healthy.publishOnce()).toBe(0); // not due yet
    await sleep(400);
    while ((await healthy.publishOnce()) > 0) {
      // publish after backoff
    }
    expect(await pendingEventIdsFor(walletIds)).toEqual([]);
  });
});
