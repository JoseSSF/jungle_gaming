import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { v7 as uuidv7 } from 'uuid';
import { wagerPayload } from '../support/api';
import { startApp } from '../support/app';
import { prepareDatabase, scalar } from '../support/database';
import { type Env, eventually, uniqueQueues } from '../support/env';
import { assertGlobalInvariants, walletState } from '../support/invariants';
import { drain, ensureQueues, queueDepth, sendWagerMessage } from '../support/sqs';

let app: Awaited<ReturnType<typeof startApp>>;
let queues: { main: string; dlq: string; events: string };
const env: Env = { ...uniqueQueues('consumer'), WORKERS: 'consumer' };

beforeAll(async () => {
  await prepareDatabase();
  queues = await ensureQueues(env);
  app = await startApp(env);
});

afterAll(async () => {
  await app?.close();
  await assertGlobalInvariants();
});

const failureReasons = (messages: Awaited<ReturnType<typeof drain>>) =>
  messages.map((message) => message.MessageAttributes?.failureReason?.StringValue);

describe('SQS consumer', () => {
  test('processes a message through the same use case and acks after commit', async () => {
    const { walletId, playerId } = await app.api.createWallet('100.00');
    const messageId = await sendWagerMessage(queues.main, wagerPayload(walletId, playerId, { amount: '25.00' }));
    await eventually(async () => (await walletState(walletId)).balance === '75.00');
    await eventually(async () => (await queueDepth(queues.main)) === 0);
    expect(await scalar<boolean>('SELECT processed_at IS NOT NULL FROM inbox_messages WHERE message_id = $1', [messageId])).toBe(true);
  });

  test('redelivery of the same messageId is absorbed by the persistent inbox', async () => {
    const { walletId, playerId } = await app.api.createWallet('100.00');
    const data = wagerPayload(walletId, playerId, { amount: '10.00' });
    const messageId = `msg-${uuidv7()}`;
    // Different broker dedup ids: the broker delivers all three; only the inbox can dedupe.
    for (let i = 0; i < 3; i += 1) await sendWagerMessage(queues.main, data, { messageId });
    await eventually(async () => (await queueDepth(queues.main)) === 0);
    expect(await walletState(walletId)).toMatchObject({ balance: '90.00', debits: 1 });
    expect(await scalar<number>('SELECT COUNT(*)::int FROM inbox_messages WHERE message_id = $1', [messageId])).toBe(1);
    const metrics = String((await app.api.request('GET', '/metrics')).body);
    expect(metrics).toMatch(/wagering_duplicates_detected_total\{[^}]*kind="inbox-message"[^}]*\} [1-9]/);
  });

  test('different messageIds carrying the same idempotency key are a replay (one debit)', async () => {
    const { walletId, playerId } = await app.api.createWallet('100.00');
    const data = wagerPayload(walletId, playerId, { amount: '10.00' });
    const first = await sendWagerMessage(queues.main, data);
    const second = await sendWagerMessage(queues.main, data);
    await eventually(async () => (await queueDepth(queues.main)) === 0);
    expect(await walletState(walletId)).toMatchObject({ balance: '90.00', debits: 1 });
    // Both messages were consumed (two inbox rows) but only one produced a debit.
    expect(
      await scalar<number>('SELECT COUNT(*)::int FROM inbox_messages WHERE message_id = ANY($1)', [[first, second]]),
    ).toBe(2);
  });

  test('HTTP and SQS share idempotency: same key through both channels applies once', async () => {
    const { walletId, playerId } = await app.api.createWallet('100.00');
    const data = wagerPayload(walletId, playerId, { amount: '5.00' });
    expect((await app.api.submit(data)).status).toBe(201);
    await sendWagerMessage(queues.main, data);
    await eventually(async () => (await queueDepth(queues.main)) === 0);
    expect(await walletState(walletId)).toMatchObject({ balance: '95.00', debits: 1 });
  });

  test('business rejection is terminal: acked, not dead-lettered', async () => {
    const { walletId, playerId } = await app.api.createWallet('1.00');
    const data = wagerPayload(walletId, playerId, { amount: '2.00' });
    await sendWagerMessage(queues.main, data);
    await eventually(async () => (await queueDepth(queues.main)) === 0);
    expect(
      await scalar('SELECT failure_code FROM wager_transactions WHERE external_transaction_id = $1', [data.externalTransactionId]),
    ).toBe('INSUFFICIENT_FUNDS');
    expect(await drain(queues.dlq)).toHaveLength(0);
  });

  test('malformed messages and idempotency conflicts are permanent: moved to the DLQ', async () => {
    const { walletId, playerId } = await app.api.createWallet('100.00');
    const data = wagerPayload(walletId, playerId, { amount: '10.00' });
    await sendWagerMessage(queues.main, data);
    await eventually(async () => (await walletState(walletId)).debits === 1);

    await sendWagerMessage(queues.main, { ...data, money: { amount: '99.00', currency: 'BRL' } });
    await sendWagerMessage(queues.main, {}, { body: '{"not":"a wager"' });
    await sendWagerMessage(queues.main, { ...data, kind: 'OPENING' });

    const dead = await eventually(async () => {
      const messages = await drain(queues.dlq);
      return messages.length > 0 ? messages : undefined;
    });
    const more = await drain(queues.dlq, 2);
    const reasons = failureReasons([...dead, ...more]).sort();
    expect(reasons).toEqual(['IDEMPOTENCY_KEY_CONFLICT', 'INVALID_MESSAGE', 'INVALID_PAYLOAD']);
    expect(await walletState(walletId)).toMatchObject({ balance: '90.00', debits: 1 });
    expect(await queueDepth(queues.main)).toBe(0);
  });
});

describe('transient failures', () => {
  test('are retried with backoff and dead-lettered after SQS_MAX_ATTEMPTS', async () => {
    // A consumer whose database is unreachable: every attempt is a transient failure.
    const brokenEnv: Env = {
      ...uniqueQueues('transient'),
      WORKERS: 'consumer',
      DATABASE_URL: 'postgres://wagering:wagering@127.0.0.1:1/wagering_test',
      DATABASE_CONNECT_TIMEOUT_MS: '500',
      SQS_MAX_ATTEMPTS: '3',
      SQS_VISIBILITY_TIMEOUT_SECONDS: '2',
    };
    const brokenQueues = await ensureQueues(brokenEnv);
    const broken = await startApp(brokenEnv);
    try {
      const ready = await broken.api.request('GET', '/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.body.checks.database.status).toBe('down');

      await sendWagerMessage(brokenQueues.main, wagerPayload(uuidv7(), 'player-x'));
      const dead = await eventually(async () => {
        const messages = await drain(brokenQueues.dlq);
        return messages.length > 0 ? messages : undefined;
      }, 45_000);
      expect(failureReasons(dead)).toEqual(['RETRIES_EXHAUSTED']);
      expect(Number(dead[0]?.MessageAttributes?.receiveCount?.StringValue)).toBe(3);
      const metrics = String((await broken.api.request('GET', '/metrics')).body);
      expect(metrics).toMatch(/wagering_retries_total\{[^}]*operation="sqs-consume"[^}]*\} [1-9]/);
      expect(metrics).toMatch(/wagering_sqs_dlq_messages_total\{[^}]*reason="RETRIES_EXHAUSTED"[^}]*\} 1/);
    } finally {
      await broken.close();
    }
  }, 60_000);
});
