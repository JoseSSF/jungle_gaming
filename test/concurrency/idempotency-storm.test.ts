import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { wagerPayload } from '../support/api';
import { startApp } from '../support/app';
import { prepareDatabase, scalar } from '../support/database';
import { type Env, eventually, uniqueQueues } from '../support/env';
import { assertGlobalInvariants, walletState } from '../support/invariants';
import { ensureQueues, queueDepth, sendWagerMessage } from '../support/sqs';

const env: Env = { ...uniqueQueues('storm'), WORKERS: 'consumer', DATABASE_POOL_MAX: '20' };
let app: Awaited<ReturnType<typeof startApp>>;
let queues: { main: string };

beforeAll(async () => {
  await prepareDatabase();
  queues = await ensureQueues(env);
  app = await startApp(env);
});

afterAll(async () => {
  await app?.close();
  await assertGlobalInvariants();
});

describe('the same bet sent 50 times in parallel', () => {
  test('HTTP: one debit, one transaction, 49 replays with the original response', async () => {
    const { walletId, playerId } = await app.api.createWallet('1000.00');
    const payload = wagerPayload(walletId, playerId, { amount: '25.00' });

    const responses = await Promise.all(Array.from({ length: 50 }, () => app.api.submit(payload)));

    expect(responses.map((r) => r.status)).toEqual(Array(50).fill(201));
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(responses.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(responses.filter((r) => r.body.idempotentReplay === true)).toHaveLength(49);
    expect(new Set(responses.map((r) => r.body.balance.amount))).toEqual(new Set(['975.00']));
    expect(await walletState(walletId)).toEqual({ balance: '975.00', version: 2, entries: 2, debits: 1 });
  });

  test('HTTP: 50 parallel requests with the same key but different payloads → 1 winner, 49 conflicts', async () => {
    const { walletId, playerId } = await app.api.createWallet('1000.00');
    const base = wagerPayload(walletId, playerId);
    const key = `provider-a:${base.externalTransactionId}`;
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        app.api.submit({ ...base, money: { amount: `${i + 1}.00`, currency: 'BRL' } }, key),
      ),
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(49);
    expect((await walletState(walletId)).debits).toBe(1);
  });

  test('SQS: 50 messages (distinct messageIds) with the same idempotency key → one debit', async () => {
    const { walletId, playerId } = await app.api.createWallet('1000.00');
    const data = wagerPayload(walletId, playerId, { amount: '25.00' });
    await Promise.all(Array.from({ length: 50 }, () => sendWagerMessage(queues.main, data)));
    await eventually(async () => (await queueDepth(queues.main)) === 0, 60_000);
    expect(await walletState(walletId)).toEqual({ balance: '975.00', version: 2, entries: 2, debits: 1 });
    expect(
      await scalar<number>('SELECT COUNT(*)::int FROM wager_transactions WHERE external_transaction_id = $1', [
        data.externalTransactionId,
      ]),
    ).toBe(1);
  }, 90_000);
});
