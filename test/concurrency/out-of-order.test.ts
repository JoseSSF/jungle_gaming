import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { wagerPayload } from '../support/api';
import { type AppProcess, killAll, spawnApp } from '../support/app';
import { db, prepareDatabase, scalar } from '../support/database';
import { type Env, eventually, uniqueQueues } from '../support/env';
import { assertGlobalInvariants, walletState } from '../support/invariants';
import { ensureQueues, queueDepth, sendWagerMessage } from '../support/sqs';

const env: Env = {
  ...uniqueQueues('ooo'),
  WORKERS: 'consumer,outbox,pending-references',
  PENDING_REFERENCE_BASE_DELAY_MS: '300',
  PENDING_REFERENCE_MAX_DELAY_MS: '1000',
  PENDING_REFERENCE_MAX_ATTEMPTS: '30',
};
let instances: AppProcess[] = [];
let queues: { main: string };

beforeAll(async () => {
  await prepareDatabase();
  queues = await ensureQueues(env);
  instances = await Promise.all(['ooo-1', 'ooo-2', 'ooo-3'].map((name) => spawnApp(name, env)));
}, 120_000);

afterAll(async () => {
  await killAll(instances);
  await assertGlobalInvariants();
});

describe('ROLLBACK / REFUND delivered before their reference, across 3 instances', () => {
  test('reversals wait as PENDING_REFERENCE and are applied exactly once when the BET arrives', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, (_, i) => instances[i % 3]!.api.createWallet('100.00')));
    const plans = wallets.map(({ walletId, playerId }) => {
      const bet1 = wagerPayload(walletId, playerId, { amount: '10.00', roundId: 'r1' });
      const bet2 = wagerPayload(walletId, playerId, { amount: '20.00', roundId: 'r2' });
      const rollback = wagerPayload(walletId, playerId, {
        kind: 'ROLLBACK',
        amount: '10.00',
        roundId: 'r1',
        referenceExternalTransactionId: bet1.externalTransactionId as string,
      });
      const refund = wagerPayload(walletId, playerId, {
        kind: 'REFUND',
        amount: '20.00',
        roundId: 'r2',
        referenceExternalTransactionId: bet2.externalTransactionId as string,
      });
      return { walletId, bet1, bet2, rollback, refund };
    });

    // 1) Reversals first (and duplicated), through the queue.
    await Promise.all(
      plans.flatMap((plan) => [
        sendWagerMessage(queues.main, plan.rollback),
        sendWagerMessage(queues.main, plan.refund),
        sendWagerMessage(queues.main, plan.refund),
      ]),
    );
    await eventually(
      async () =>
        (await scalar<number>(
          `SELECT COUNT(*)::int FROM wager_transactions WHERE status = 'PENDING_REFERENCE' AND wallet_id = ANY($1)`,
          [wallets.map((w) => w.walletId)],
        )) === 20,
      60_000,
    );

    // 2) The referenced BETs arrive later, through HTTP on different instances.
    await Promise.all(
      plans.flatMap((plan, i) => [instances[i % 3]!.api.submit(plan.bet1), instances[(i + 1) % 3]!.api.submit(plan.bet2)]),
    );

    await eventually(
      async () =>
        (await scalar<number>(
          `SELECT COUNT(*)::int FROM wager_transactions WHERE status = 'PROCESSED' AND kind IN ('ROLLBACK','REFUND') AND wallet_id = ANY($1)`,
          [wallets.map((w) => w.walletId)],
        )) === 20,
      60_000,
    );
    await eventually(async () => (await queueDepth(queues.main)) === 0, 30_000);

    for (const plan of plans) {
      // opening + bet1 + bet2 + rollback + refund
      expect(await walletState(plan.walletId)).toEqual({ balance: '100.00', version: 5, entries: 5, debits: 2 });
    }
    const leftovers = await db().query(
      `SELECT id FROM wager_transactions WHERE status = 'PENDING_REFERENCE' AND wallet_id = ANY($1)`,
      [wallets.map((w) => w.walletId)],
    );
    expect(leftovers.rows).toEqual([]);
  }, 150_000);
});
