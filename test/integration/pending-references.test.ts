import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { wagerPayload } from '../support/api';
import { startApp } from '../support/app';
import { prepareDatabase, scalar } from '../support/database';
import { eventually, uniqueQueues } from '../support/env';
import { assertGlobalInvariants, walletState } from '../support/invariants';

let app: Awaited<ReturnType<typeof startApp>>;

beforeAll(async () => {
  await prepareDatabase();
  app = await startApp({
    ...uniqueQueues('pending'),
    WORKERS: 'pending-references',
    PENDING_REFERENCE_BASE_DELAY_MS: '200',
    PENDING_REFERENCE_MAX_DELAY_MS: '400',
    PENDING_REFERENCE_MAX_ATTEMPTS: '4',
  });
});

afterAll(async () => {
  await app?.close();
  await assertGlobalInvariants();
});

const txStatus = (id: string) => app.api.request('GET', `/wagering/transactions/${id}`).then((r) => r.body);

describe('references delivered out of order', () => {
  test('ROLLBACK before its BET: 202 PENDING_REFERENCE, then applied by the worker', async () => {
    const { walletId, playerId } = await app.api.createWallet('100.00');
    const bet = wagerPayload(walletId, playerId, { amount: '40.00' });
    const rollback = await app.api.submit(
      wagerPayload(walletId, playerId, {
        kind: 'ROLLBACK',
        amount: '40.00',
        referenceExternalTransactionId: bet.externalTransactionId as string,
      }),
    );
    expect(rollback.status).toBe(202);
    expect(rollback.body.status).toBe('PENDING_REFERENCE');
    expect(rollback.body.nextReferenceCheckAt).toBeString();
    expect(
      await scalar<number>(
        `SELECT COUNT(*)::int FROM outbox_messages WHERE aggregate_id = $1 AND event_type = 'WagerTransactionPendingReference'`,
        [rollback.body.transactionId],
      ),
    ).toBe(1);

    expect((await app.api.submit(bet)).body.balance.amount).toBe('60.00');
    const resolved = await eventually(async () => {
      const body = await txStatus(rollback.body.transactionId);
      return body.status === 'PROCESSED' ? body : undefined;
    });
    expect(resolved.referenceTransactionId).toBeString();
    expect(resolved.balance.amount).toBe('100.00');
    expect(await walletState(walletId)).toEqual({ balance: '100.00', version: 3, entries: 3, debits: 1 });
  });

  test('REFUND before its BET is applied once, even if the refund is replayed meanwhile', async () => {
    const { walletId, playerId } = await app.api.createWallet('100.00');
    const bet = wagerPayload(walletId, playerId, { amount: '10.00' });
    const refundPayload = wagerPayload(walletId, playerId, {
      kind: 'REFUND',
      amount: '10.00',
      referenceExternalTransactionId: bet.externalTransactionId as string,
    });
    const refund = await app.api.submit(refundPayload);
    expect(refund.status).toBe(202);
    const replay = await app.api.submit(refundPayload);
    expect(replay.status).toBe(202);
    expect(replay.body.idempotentReplay).toBe(true);
    await app.api.submit(bet);
    await eventually(async () => (await txStatus(refund.body.transactionId)).status === 'PROCESSED');
    expect(await walletState(walletId)).toMatchObject({ balance: '100.00', debits: 1, entries: 3 });
  });

  test('reference that never arrives → REJECTED REFERENCE_NOT_FOUND with an event', async () => {
    const { walletId, playerId } = await app.api.createWallet('100.00');
    const refund = await app.api.submit(
      wagerPayload(walletId, playerId, { kind: 'REFUND', amount: '10.00', referenceExternalTransactionId: 'never-sent' }),
    );
    expect(refund.status).toBe(202);
    const final = await eventually(async () => {
      const body = await txStatus(refund.body.transactionId);
      return body.status === 'REJECTED' ? body : undefined;
    }, 15_000);
    expect(final.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(
      await scalar<number>(
        `SELECT COUNT(*)::int FROM outbox_messages WHERE aggregate_id = $1 AND event_type = 'WagerTransactionRejected'`,
        [refund.body.transactionId],
      ),
    ).toBe(1);
    expect(await scalar<number>('SELECT reference_attempts FROM wager_transactions WHERE id = $1', [refund.body.transactionId])).toBe(3);
    // Late arrival of the reference no longer changes anything for the rejected refund.
    expect((await walletState(walletId)).balance).toBe('100.00');
  });

  test('reference from another round is rejected immediately', async () => {
    const { walletId, playerId } = await app.api.createWallet('100.00');
    const bet = wagerPayload(walletId, playerId, { amount: '10.00', roundId: 'round-a' });
    await app.api.submit(bet);
    const refund = await app.api.submit(
      wagerPayload(walletId, playerId, {
        kind: 'REFUND',
        amount: '10.00',
        roundId: 'round-b',
        referenceExternalTransactionId: bet.externalTransactionId as string,
      }),
    );
    expect(refund.status).toBe(422);
    expect(refund.body.failureCode).toBe('REFERENCE_MISMATCH');
  });
});
