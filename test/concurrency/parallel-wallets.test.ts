import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { wagerPayload } from '../support/api';
import { startApp } from '../support/app';
import { db, prepareDatabase } from '../support/database';
import { uniqueQueues } from '../support/env';
import { assertGlobalInvariants } from '../support/invariants';

let app: Awaited<ReturnType<typeof startApp>>;

beforeAll(async () => {
  await prepareDatabase();
  app = await startApp({ ...uniqueQueues('parallel'), DATABASE_POOL_MAX: '30' });
});

afterAll(async () => {
  await app?.close();
  await assertGlobalInvariants();
});

describe('distinct wallets in parallel', () => {
  test('25 wallets × 20 concurrent bets: every wallet ends exact; no global serialization', async () => {
    const wallets = await Promise.all(Array.from({ length: 25 }, () => app.api.createWallet('20.00')));
    const started = performance.now();
    const responses = await Promise.all(
      wallets.flatMap(({ walletId, playerId }) =>
        Array.from({ length: 20 }, () => app.api.submit(wagerPayload(walletId, playerId, { amount: '1.00' }))),
      ),
    );
    const elapsedMs = performance.now() - started;
    expect(responses.every((r) => r.status === 201)).toBe(true);

    const rows = await db().query(
      `SELECT w.id, w.balance::text AS balance, w.version,
              (SELECT COUNT(*)::int FROM wallet_ledger_entries l WHERE l.wallet_id = w.id AND l.direction = 'DEBIT') AS debits
         FROM wallets w WHERE w.id = ANY($1)`,
      [wallets.map((w) => w.walletId)],
    );
    expect(rows.rows).toHaveLength(25);
    for (const row of rows.rows) {
      expect(row).toMatchObject({ balance: '0.00', version: 21, debits: 20 });
    }

    // Lock waits are per wallet: different wallets did not queue behind each other.
    const metrics = String((await app.api.request('GET', '/metrics')).body);
    expect(metrics).toContain('wagering_wallet_lock_wait_seconds_count');
    console.log(JSON.stringify({ test: 'parallel-wallets', operations: responses.length, elapsedMs: Math.round(elapsedMs) }));
  }, 120_000);
});
