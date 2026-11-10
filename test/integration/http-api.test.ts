import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { v7 as uuidv7 } from 'uuid';
import type { Api } from '../support/api';
import { wagerPayload } from '../support/api';
import { startApp } from '../support/app';
import { db, prepareDatabase, scalar } from '../support/database';
import { uniqueQueues } from '../support/env';
import { assertGlobalInvariants, walletState } from '../support/invariants';

let app: Awaited<ReturnType<typeof startApp>>;
let api: Api;

beforeAll(async () => {
  await prepareDatabase();
  app = await startApp({ ...uniqueQueues('http') });
  api = app.api;
});

afterAll(async () => {
  await app?.close();
  await assertGlobalInvariants();
});

describe('POST /wallets', () => {
  test('creates the wallet with an OPENING transaction and CREDIT entry in one SQL transaction', async () => {
    const playerId = `player-${uuidv7()}`;
    const response = await api.request('POST', '/wallets', {
      playerId,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
    const walletId = response.body.id as string;
    expect(await walletState(walletId)).toEqual({ balance: '1000.00', version: 1, entries: 1, debits: 0 });
    expect(await scalar(`SELECT status FROM wager_transactions WHERE wallet_id = $1 AND kind = 'OPENING'`, [walletId])).toBe(
      'PROCESSED',
    );
    expect(
      await scalar<number>(`SELECT COUNT(*)::int FROM outbox_messages WHERE payload->'data'->>'walletId' = $1`, [walletId]),
    ).toBe(2);
  });

  test('zero initial balance → no OPENING, version 1', async () => {
    const { walletId } = await api.createWallet('0.00');
    expect(await walletState(walletId)).toEqual({ balance: '0.00', version: 1, entries: 0, debits: 0 });
  });

  test('duplicate playerId + currency is a 409 conflict; another currency is allowed', async () => {
    const { playerId } = await api.createWallet('10.00');
    const duplicate = await api.request('POST', '/wallets', { playerId, initialBalance: { amount: '1.00', currency: 'BRL' } });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('WALLET_ALREADY_EXISTS');
    const usd = await api.request('POST', '/wallets', { playerId, initialBalance: { amount: '1.00', currency: 'USD' } });
    expect(usd.status).toBe(201);
  });

  test('invalid payloads are 400 with issues', async () => {
    for (const body of [
      { playerId: 'p', initialBalance: { amount: 10, currency: 'BRL' } },
      { playerId: 'p', initialBalance: { amount: '1.001', currency: 'BRL' } },
      { playerId: '', initialBalance: { amount: '1.00', currency: 'BRL' } },
      { playerId: 'p' },
    ]) {
      const response = await api.request('POST', '/wallets', body);
      expect(response.status).toBe(400);
      expect(response.body.error.retryable).toBe(false);
    }
    const malformed = await api.request('POST', '/wallets', '{not json');
    expect(malformed.status).toBe(400);
  });
});

describe('POST /wagering/transactions', () => {
  test('BET → 201 PROCESSED with balance; replay → same response with idempotentReplay=true', async () => {
    const { walletId, playerId } = await api.createWallet('1000.00');
    const payload = wagerPayload(walletId, playerId, { amount: '25.00' });
    const first = await api.submit(payload);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: false });
    expect(first.headers.get('location')).toBe(`/wagering/transactions/${first.body.transactionId}`);

    // Another bet moves the balance; the replay must still report the original snapshot.
    await api.submit(wagerPayload(walletId, playerId, { amount: '100.00' }));
    const replay = await api.submit(payload);
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect((await walletState(walletId)).debits).toBe(2);
  });

  test('same key with a different payload → 409, never a replay', async () => {
    const { walletId, playerId } = await api.createWallet('100.00');
    const payload = wagerPayload(walletId, playerId, { amount: '10.00' });
    expect((await api.submit(payload)).status).toBe(201);
    const conflict = await api.submit({ ...payload, money: { amount: '10.01', currency: 'BRL' } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect(conflict.body.error.existingTransactionId).toBeString();
    expect((await walletState(walletId)).balance).toBe('90.00');
  });

  test('business rejection → 422 with a stable failureCode; replay keeps it', async () => {
    const { walletId, playerId } = await api.createWallet('50.00');
    const payload = wagerPayload(walletId, playerId, { amount: '50.01' });
    const rejected = await api.submit(payload);
    expect(rejected.status).toBe(422);
    expect(rejected.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      providerAction: 'GIVE_UP',
      balance: { amount: '50.00', currency: 'BRL' },
    });
    const replay = await api.submit(payload);
    expect(replay.status).toBe(422);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(await walletState(walletId)).toMatchObject({ balance: '50.00', version: 1, entries: 1 });
  });

  test('missing Idempotency-Key, OPENING, numeric amount, >2 decimals → 400', async () => {
    const { walletId, playerId } = await api.createWallet('50.00');
    const payload = wagerPayload(walletId, playerId);
    expect((await api.request('POST', '/wagering/transactions', payload)).status).toBe(400);
    expect((await api.submit({ ...payload, kind: 'OPENING' })).status).toBe(400);
    expect((await api.submit({ ...payload, money: { amount: 10, currency: 'BRL' } })).status).toBe(400);
    expect((await api.submit({ ...payload, money: { amount: '10.001', currency: 'BRL' } })).status).toBe(400);
    expect((await api.submit({ ...payload, kind: 'REFUND' })).status).toBe(400);
  });

  test('unknown wallet → 422 WALLET_NOT_FOUND', async () => {
    const response = await api.submit(wagerPayload(uuidv7(), 'player-x'));
    expect(response.status).toBe(422);
    expect(response.body.failureCode).toBe('WALLET_NOT_FOUND');
  });

  test('currency conflict → 422 CURRENCY_MISMATCH', async () => {
    const { walletId, playerId } = await api.createWallet('50.00');
    const response = await api.submit(wagerPayload(walletId, playerId, { currency: 'USD' }));
    expect(response.status).toBe(422);
    expect(response.body.failureCode).toBe('CURRENCY_MISMATCH');
  });

  test('full round: BET, WIN, LOSS, REFUND, ROLLBACK', async () => {
    const { walletId, playerId } = await api.createWallet('100.00');
    const bet1 = wagerPayload(walletId, playerId, { amount: '20.00', roundId: 'r1' });
    expect((await api.submit(bet1)).body.balance.amount).toBe('80.00');
    const win = wagerPayload(walletId, playerId, {
      kind: 'WIN',
      amount: '50.00',
      roundId: 'r1',
      referenceExternalTransactionId: bet1.externalTransactionId as string,
    });
    expect((await api.submit(win)).body.balance.amount).toBe('130.00');

    const bet2 = wagerPayload(walletId, playerId, { amount: '30.00', roundId: 'r2' });
    await api.submit(bet2);
    const loss = await api.submit(
      wagerPayload(walletId, playerId, { kind: 'LOSS', amount: '0.00', roundId: 'r2', referenceExternalTransactionId: bet2.externalTransactionId as string }),
    );
    expect(loss.status).toBe(201);
    expect(loss.body.balance.amount).toBe('100.00');

    const bet3 = wagerPayload(walletId, playerId, { amount: '15.00', roundId: 'r3' });
    await api.submit(bet3);
    const refund = wagerPayload(walletId, playerId, {
      kind: 'REFUND',
      amount: '15.00',
      roundId: 'r3',
      referenceExternalTransactionId: bet3.externalTransactionId as string,
    });
    expect((await api.submit(refund)).body.balance.amount).toBe('100.00');
    const refundAgain = await api.submit({ ...refund, externalTransactionId: `again-${uuidv7()}` });
    expect(refundAgain.status).toBe(422);
    expect(refundAgain.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');

    const rollbackWin = wagerPayload(walletId, playerId, {
      kind: 'ROLLBACK',
      amount: '50.00',
      roundId: 'r1',
      referenceExternalTransactionId: win.externalTransactionId as string,
    });
    expect((await api.submit(rollbackWin)).body.balance.amount).toBe('50.00');

    // 1 opening + bet1 + win + bet2 + bet3 + refund + rollback = 7 entries (LOSS has none)
    expect(await walletState(walletId)).toEqual({ balance: '50.00', version: 7, entries: 7, debits: 4 });
  });

  test('reversal that would overdraw → 422 REVERSAL_WOULD_OVERDRAW (auditable)', async () => {
    const { walletId, playerId } = await api.createWallet('0.00');
    const win = wagerPayload(walletId, playerId, { kind: 'WIN', amount: '40.00' });
    await api.submit(win);
    await api.submit(wagerPayload(walletId, playerId, { amount: '40.00' }));
    const rollback = await api.submit(
      wagerPayload(walletId, playerId, { kind: 'ROLLBACK', amount: '40.00', referenceExternalTransactionId: win.externalTransactionId as string }),
    );
    expect(rollback.status).toBe(422);
    expect(rollback.body.failureCode).toBe('REVERSAL_WOULD_OVERDRAW');
    const stored = await api.request('GET', `/wagering/transactions/${rollback.body.transactionId}`);
    expect(stored.body).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_WOULD_OVERDRAW' });
  });
});

describe('queries', () => {
  test('GET transaction by id and by provider external id', async () => {
    const { walletId, playerId } = await api.createWallet('10.00');
    const payload = wagerPayload(walletId, playerId, { amount: '1.00' });
    const submitted = await api.submit(payload);
    const byId = await api.request('GET', `/wagering/transactions/${submitted.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ kind: 'BET', status: 'PROCESSED', money: { amount: '1.00', currency: 'BRL' } });
    const byExternal = await api.request('GET', `/providers/provider-a/wagering/transactions/${payload.externalTransactionId}`);
    expect(byExternal.body.transactionId).toBe(submitted.body.transactionId);
    expect((await api.request('GET', `/wagering/transactions/${uuidv7()}`)).status).toBe(404);
    expect((await api.request('GET', '/wagering/transactions/not-a-uuid')).status).toBe(400);
  });

  test('ledger pagination: stable opaque cursor, newest first, no gaps or repeats', async () => {
    const { walletId, playerId } = await api.createWallet('100.00');
    for (let i = 0; i < 11; i += 1) await api.submit(wagerPayload(walletId, playerId, { amount: '1.00' }));
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=5&cursor=${encodeURIComponent(cursor)}` : '?limit=5';
      const page = await api.request('GET', `/wallets/${walletId}/ledger${query}`);
      expect(page.status).toBe(200);
      seen.push(...(page.body.items as Array<{ walletVersion: number }>).map((item) => item.walletVersion));
      // New entries appended while paginating must not shift older pages.
      if (!cursor) await api.submit(wagerPayload(walletId, playerId, { amount: '1.00' }));
      cursor = page.body.nextCursor as string | null;
    } while (cursor);
    expect(seen).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect((await api.request('GET', `/wallets/${walletId}/ledger?cursor=garbage`)).status).toBe(400);
    expect((await api.request('GET', `/wallets/${walletId}/ledger?limit=0`)).status).toBe(400);
  });

  test('reconciliation reports a consistent wallet and is read-only', async () => {
    const { walletId, playerId } = await api.createWallet('975.00');
    await api.submit(wagerPayload(walletId, playerId, { amount: '25.00' }));
    const report = await api.reconcile(walletId);
    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({
      walletId,
      storedBalance: { amount: '950.00', currency: 'BRL' },
      calculatedBalance: { amount: '950.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
    expect((await api.reconcile(uuidv7())).status).toBe(404);
  });
});

describe('health and metrics', () => {
  test('liveness and readiness are public', async () => {
    expect((await api.request('GET', '/health/live')).status).toBe(200);
    const ready = await api.request('GET', '/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks.database.status).toBe('up');
    expect(ready.body.checks.sqs.status).toBe('up');
  });

  test('metrics expose business counters', async () => {
    const metrics = await api.request('GET', '/metrics');
    expect(metrics.status).toBe(200);
    const text = String(metrics.body);
    for (const name of [
      'wagering_transactions_total',
      'wagering_duplicates_detected_total',
      'wagering_wallet_lock_wait_seconds',
      'wagering_processing_duration_seconds',
      'wagering_idempotency_conflicts_total',
    ]) {
      expect(text).toContain(name);
    }
  });

  test('every response carries a correlation id', async () => {
    const response = await api.request('GET', '/health/live', undefined, { 'x-correlation-id': 'corr-test-1' });
    expect(response.headers.get('x-correlation-id')).toBe('corr-test-1');
  });
});

describe('database state', () => {
  test('no row was ever left in PENDING (it is an in-memory state only)', async () => {
    expect(await scalar<number>(`SELECT COUNT(*)::int FROM wager_transactions WHERE status = 'PENDING'`)).toBe(0);
    const anyRows = await db().query('SELECT 1 FROM wager_transactions LIMIT 1');
    expect(anyRows.rowCount).toBe(1);
  });
});
