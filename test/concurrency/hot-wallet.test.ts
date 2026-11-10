import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { wagerPayload } from '../support/api';
import { startApp } from '../support/app';
import { prepareDatabase } from '../support/database';
import { uniqueQueues } from '../support/env';
import { assertGlobalInvariants, walletState } from '../support/invariants';

let app: Awaited<ReturnType<typeof startApp>>;

beforeAll(async () => {
  await prepareDatabase();
  app = await startApp({ ...uniqueQueues('hot'), DATABASE_POOL_MAX: '20' });
});

afterAll(async () => {
  await app?.close();
  await assertGlobalInvariants();
});

describe('mandatory scenario (section 8)', () => {
  test('100.00 BRL, two concurrent 80.00 bets → one PROCESSED, one INSUFFICIENT_FUNDS, 20.00, one debit (×20 runs)', async () => {
    for (let run = 0; run < 20; run += 1) {
      const { walletId, playerId } = await app.api.createWallet('100.00');
      const payloads = [
        wagerPayload(walletId, playerId, { amount: '80.00' }),
        wagerPayload(walletId, playerId, { amount: '80.00' }),
      ];
      const results = await Promise.all(payloads.map((payload) => app.api.submit(payload)));
      expect(results.map((r) => r.body.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
      const rejected = results.find((r) => r.body.status === 'REJECTED');
      expect(rejected?.status).toBe(422);
      expect(rejected?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(await walletState(walletId)).toEqual({ balance: '20.00', version: 2, entries: 2, debits: 1 });

      // Retrying both requests (concurrently, 3 times each) replays the original outcomes.
      const retries = await Promise.all(
        [...payloads, ...payloads, ...payloads].map((payload) => app.api.submit(payload)),
      );
      expect(retries.every((r) => r.body.idempotentReplay === true)).toBe(true);
      expect(retries.filter((r) => r.body.status === 'PROCESSED')).toHaveLength(3);
      expect(await walletState(walletId)).toEqual({ balance: '20.00', version: 2, entries: 2, debits: 1 });
    }
  }, 120_000);
});

describe('hot wallet under oversubscription', () => {
  test('100 concurrent 10.00 bets on 500.00 → exactly 50 processed, 50 rejected, balance 0.00', async () => {
    const { walletId, playerId } = await app.api.createWallet('500.00');
    const responses = await Promise.all(
      Array.from({ length: 100 }, () => app.api.submit(wagerPayload(walletId, playerId, { amount: '10.00' }))),
    );
    expect(responses.filter((r) => r.body.status === 'PROCESSED')).toHaveLength(50);
    expect(responses.filter((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(50);
    expect(await walletState(walletId)).toEqual({ balance: '0.00', version: 51, entries: 51, debits: 50 });

    // Every processed bet observed a distinct balance: the debits were strictly serialized.
    const observed = responses.filter((r) => r.body.status === 'PROCESSED').map((r) => r.body.balance.amount);
    expect(new Set(observed).size).toBe(50);
  }, 60_000);

  test('concurrent credits and debits never lose an update', async () => {
    const { walletId, playerId } = await app.api.createWallet('1000.00');
    const operations = Array.from({ length: 120 }, (_, i) =>
      app.api.submit(wagerPayload(walletId, playerId, { kind: i % 3 === 0 ? 'WIN' : 'BET', amount: '5.00' })),
    );
    const responses = await Promise.all(operations);
    expect(responses.every((r) => r.body.status === 'PROCESSED')).toBe(true);
    // 40 WIN (+200.00) and 80 BET (−400.00): 1000 + 200 − 400
    expect(await walletState(walletId)).toEqual({ balance: '800.00', version: 121, entries: 121, debits: 80 });
  }, 60_000);
});
