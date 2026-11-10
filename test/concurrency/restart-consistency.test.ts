import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ApiResponse, wagerPayload } from '../support/api';
import { type AppProcess, killAll, spawnApp } from '../support/app';
import { db, prepareDatabase, scalar } from '../support/database';
import { type Env, eventually, sleep, uniqueQueues } from '../support/env';
import { assertGlobalInvariants, walletState } from '../support/invariants';
import { ensureQueues, queueDepth, sendWagerMessage } from '../support/sqs';

/*
 * Service restart in the middle of the load, with proof of final consistency:
 * instances are SIGKILLed while consuming/serving, replacements start, providers retry
 * HTTP calls with the same Idempotency-Key, SQS redelivers — and every wallet ends exact.
 */

const env: Env = {
  ...uniqueQueues('restart'),
  WORKERS: 'consumer,outbox,pending-references',
  SQS_VISIBILITY_TIMEOUT_SECONDS: '3',
  SQS_MAX_ATTEMPTS: '10',
};
const all: AppProcess[] = [];
let queues: { main: string };

beforeAll(async () => {
  await prepareDatabase();
  queues = await ensureQueues(env);
}, 60_000);

afterAll(async () => {
  await killAll(all);
  await assertGlobalInvariants();
});

async function start(name: string, extra: Env = {}, waitReady = true): Promise<AppProcess> {
  const instance = await spawnApp(name, { ...env, ...extra }, { waitReady });
  all.push(instance);
  return instance;
}

const alive = () => all.filter((instance) => instance.proc.exitCode === null && !instance.proc.killed);

/** A provider's retry loop: same Idempotency-Key, next instance on network error / 503. */
async function submitWithRetry(payload: Record<string, unknown>, attempt = 0): Promise<ApiResponse> {
  const candidates = alive();
  const target = candidates[attempt % Math.max(1, candidates.length)];
  try {
    if (!target) throw new Error('no instance alive');
    const response = await target.api.submit(payload);
    if (response.status === 503 || response.status >= 500) throw new Error(`status ${response.status}`);
    return response;
  } catch (error) {
    if (attempt > 40) throw error;
    await sleep(250);
    return submitWithRetry(payload, attempt + 1);
  }
}

describe('restart during load', () => {
  test('SIGKILL two of three instances mid-load, restart them: every wallet is exact', async () => {
    await Promise.all(['r-1', 'r-2', 'r-3'].map((name) => start(name)));
    const wallets = await Promise.all(Array.from({ length: 12 }, (_, i) => all[i % 3]!.api.createWallet('100.00')));

    // Per wallet: 10 SQS bets (each published twice) + 10 HTTP bets = 20 debits of 1.00.
    const sqsLoad = wallets.flatMap(({ walletId, playerId }) =>
      Array.from({ length: 10 }, () => wagerPayload(walletId, playerId, { amount: '1.00' })),
    );
    const httpLoad = wallets.flatMap(({ walletId, playerId }) =>
      Array.from({ length: 10 }, () => wagerPayload(walletId, playerId, { amount: '1.00' })),
    );
    await Promise.all(sqsLoad.flatMap((payload) => [sendWagerMessage(queues.main, payload), sendWagerMessage(queues.main, payload)]));

    const httpDone = Promise.all(httpLoad.map((payload) => submitWithRetry(payload)));
    await sleep(400);
    await all[0]!.kill('SIGKILL');
    await all[1]!.kill('SIGKILL');
    await sleep(500);
    await Promise.all([start('r-1b'), start('r-2b')]);

    const responses = await httpDone;
    expect(responses.every((response) => response.status === 201)).toBe(true);
    await eventually(async () => (await queueDepth(queues.main)) === 0, 90_000);
    await eventually(
      async () => (await scalar<number>('SELECT COUNT(*)::int FROM outbox_messages WHERE published_at IS NULL')) === 0,
      60_000,
    );

    for (const { walletId } of wallets) {
      expect(await walletState(walletId)).toEqual({ balance: '80.00', version: 21, entries: 21, debits: 20 });
      const report = await alive()[0]!.api.reconcile(walletId);
      expect(report.body).toMatchObject({ consistent: true, difference: { amount: '0.00' }, checkedEntries: 21 });
    }
    // Every logical operation exists exactly once.
    const externalIds = [...sqsLoad, ...httpLoad].map((payload) => payload.externalTransactionId);
    expect(
      await scalar<number>('SELECT COUNT(*)::int FROM wager_transactions WHERE external_transaction_id = ANY($1)', [externalIds]),
    ).toBe(externalIds.length);
  }, 180_000);

  test.skipIf(process.platform === 'win32')(
    'SIGTERM drains in-flight messages and exits; nothing is lost or duplicated',
    async () => {
      const graceful = await start('graceful', { WORKERS: 'consumer', SQS_SHUTDOWN_GRACE_MS: '8000', LOG_LEVEL: 'info' });
      const { walletId, playerId } = await graceful.api.createWallet('100.00');
      await Promise.all(
        Array.from({ length: 40 }, () => sendWagerMessage(queues.main, wagerPayload(walletId, playerId, { amount: '1.00' }))),
      );
      await eventually(async () => (await walletState(walletId)).debits >= 1, 30_000, 20);
      const started = Date.now();
      graceful.proc.kill('SIGTERM');
      await graceful.exited;
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(graceful.output.join('')).toContain('sqs_consumer_stopped');

      await start('after-graceful', { WORKERS: 'consumer' });
      await eventually(async () => (await queueDepth(queues.main)) === 0, 60_000);
      expect(await walletState(walletId)).toMatchObject({ balance: '60.00', debits: 40 });
      expect(
        await db()
          .query('SELECT COUNT(*)::int AS n FROM wager_transactions WHERE wallet_id = $1 AND kind = $2', [walletId, 'BET'])
          .then((r) => r.rows[0]?.n),
      ).toBe(40);
    },
    120_000,
  );
});
