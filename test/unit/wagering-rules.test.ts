import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { parseSubmitWagerTransactionCommand } from '../../src/application/commands/submit-wager-transaction.command';
import { IdempotencyConflictError, InboxConflictError } from '../../src/application/errors';
import type { UnitOfWork } from '../../src/application/ports/repositories';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import { ResolvePendingReferencesUseCase } from '../../src/application/use-cases/resolve-pending-references.use-case';
import {
  type SubmitOptions,
  type SubmitResult,
  SubmitWagerTransactionUseCase,
} from '../../src/application/use-cases/submit-wager-transaction.use-case';
import { ReferenceRetryPolicy } from '../../src/application/wagering/reference-retry-policy';
import { WagerTransactionProcessor } from '../../src/application/wagering/wager-transaction-processor';
import { Money } from '../../src/domain/money/money';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { type WagerTransaction, WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction';
import {
  InMemoryStore,
  InMemoryUnitOfWork,
  ManualClock,
  noopMetrics,
  sequentialIds,
  silentLogger,
} from '../support/in-memory-repositories';

let store: InMemoryStore;
let clock: ManualClock;
let submitUseCase: SubmitWagerTransactionUseCase;
let resolver: ResolvePendingReferencesUseCase;
let walletId: string;
const PLAYER = 'player-1';

async function openWallet(amount: string, currency = 'BRL', playerId = PLAYER): Promise<string> {
  const useCase = new CreateWalletUseCase(new InMemoryUnitOfWork(store), sequentialIds, clock, noopMetrics, silentLogger);
  const wallet = await useCase.execute(
    { playerId, initialBalance: Money.from({ amount, currency }) },
    { correlationId: 'test' },
  );
  return wallet.id;
}

interface SendOptions {
  reference?: string;
  key?: string;
  currency?: string;
  playerId?: string;
  wallet?: string;
  round?: string;
  options?: Partial<SubmitOptions>;
}

async function send(kind: string, amount: string, externalId: string, opts: SendOptions = {}): Promise<SubmitResult> {
  const payload: Record<string, unknown> = {
    providerId: 'provider-a',
    externalTransactionId: externalId,
    playerId: opts.playerId ?? PLAYER,
    walletId: opts.wallet ?? walletId,
    roundId: opts.round ?? 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: opts.currency ?? 'BRL' },
  };
  if (opts.reference) payload.referenceExternalTransactionId = opts.reference;
  const command = parseSubmitWagerTransactionCommand(payload, opts.key ?? `provider-a:${externalId}`);
  return submitUseCase.execute(command, { source: 'http', correlationId: 'corr', ...opts.options });
}

function tx(result: SubmitResult): WagerTransaction {
  if (result.type !== 'transaction') throw new Error(`expected a transaction, got ${result.type}`);
  return result.transaction;
}

const balance = () => store.wallets.get(walletId)?.balance.toJSON().amount;
const ledgerCount = () => store.ledger.filter((entry) => entry.walletId === walletId).length;

beforeEach(async () => {
  store = new InMemoryStore();
  clock = new ManualClock();
  const uow = new InMemoryUnitOfWork(store);
  const processor = new WagerTransactionProcessor(
    sequentialIds,
    new ReferenceRetryPolicy({ baseDelayMs: 1_000, maxDelayMs: 8_000, maxAttempts: 3, ttlMs: 60_000 }),
  );
  submitUseCase = new SubmitWagerTransactionUseCase(uow, processor, sequentialIds, clock, noopMetrics, silentLogger, {
    lockTimeoutMs: 1_000,
    maxConflictRetries: 3,
  });
  resolver = new ResolvePendingReferencesUseCase(uow, processor, sequentialIds, clock, noopMetrics, silentLogger, {
    batchSize: 10,
    lockTimeoutMs: 1_000,
    maxConflictRetries: 3,
  });
  walletId = await openWallet('100.00');
});

afterEach(() => {
  // Final invariant of every test: materialized balance == balance rebuilt from the ledger.
  for (const wallet of store.wallets.values()) {
    expect(store.balanceFromLedger(wallet.id, wallet.currency).equals(wallet.balance)).toBe(true);
  }
});

describe('wallet opening', () => {
  test('creates OPENING transaction + CREDIT entry + events in the same unit of work', () => {
    expect(balance()).toBe('100.00');
    expect(ledgerCount()).toBe(1);
    const opening = [...store.transactions.values()].find((t) => t.kind === 'OPENING');
    expect(opening?.status).toBe(WagerTransactionStatus.Processed);
    expect(store.events('WalletBalanceChanged')).toHaveLength(1);
  });
});

describe('BET', () => {
  test('debits and records one DEBIT entry', async () => {
    const result = tx(await send('BET', '25.00', 'bet-1'));
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balanceAfter?.toJSON().amount).toBe('75.00');
    expect(balance()).toBe('75.00');
    expect(ledgerCount()).toBe(2);
    expect(store.wallets.get(walletId)?.version).toBe(2);
  });

  test('insufficient funds → REJECTED INSUFFICIENT_FUNDS, no ledger, balance untouched', async () => {
    const result = tx(await send('BET', '100.01', 'bet-1'));
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(balance()).toBe('100.00');
    expect(ledgerCount()).toBe(1);
    expect(store.wallets.get(walletId)?.version).toBe(1);
    expect(store.events('WagerTransactionRejected')).toHaveLength(1);
  });
});

describe('WIN / LOSS', () => {
  test('WIN credits and may reference the BET of the same round', async () => {
    const bet = tx(await send('BET', '10.00', 'bet-1'));
    const win = tx(await send('WIN', '30.00', 'win-1', { reference: 'bet-1' }));
    expect(win.status).toBe(WagerTransactionStatus.Processed);
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(balance()).toBe('120.00');
  });

  test('LOSS is PROCESSED without moving money nor creating ledger entries', async () => {
    await send('BET', '10.00', 'bet-1');
    const changesBefore = store.events('WalletBalanceChanged').length;
    const loss = tx(await send('LOSS', '0.00', 'loss-1', { reference: 'bet-1' }));
    expect(loss.status).toBe(WagerTransactionStatus.Processed);
    expect(balance()).toBe('90.00');
    expect(ledgerCount()).toBe(2);
    expect(store.events('WalletBalanceChanged')).toHaveLength(changesBefore);
    expect(store.events('WagerTransactionProcessed').some((e) => e.aggregateId === loss.id)).toBe(true);
  });
});

describe('REFUND / ROLLBACK', () => {
  test('REFUND reverts a processed BET exactly once', async () => {
    await send('BET', '40.00', 'bet-1');
    const refund = tx(await send('REFUND', '40.00', 'refund-1', { reference: 'bet-1' }));
    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(balance()).toBe('100.00');
    const again = tx(await send('REFUND', '40.00', 'refund-2', { reference: 'bet-1' }));
    expect(again.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    const rollback = tx(await send('ROLLBACK', '40.00', 'rollback-1', { reference: 'bet-1' }));
    expect(rollback.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(balance()).toBe('100.00');
  });

  test('REFUND of a WIN is not allowed; amount must match', async () => {
    await send('BET', '10.00', 'bet-1');
    await send('WIN', '20.00', 'win-1');
    expect(tx(await send('REFUND', '20.00', 'refund-1', { reference: 'win-1' })).failureCode).toBe(
      FailureCode.ReferenceKindNotAllowed,
    );
    expect(tx(await send('REFUND', '9.99', 'refund-2', { reference: 'bet-1' })).failureCode).toBe(
      FailureCode.ReferenceAmountMismatch,
    );
  });

  test('ROLLBACK inverts BET (credit), WIN (debit) and REFUND (debit)', async () => {
    await send('BET', '10.00', 'bet-1');
    await send('ROLLBACK', '10.00', 'rb-bet', { reference: 'bet-1' });
    expect(balance()).toBe('100.00');
    await send('WIN', '50.00', 'win-1');
    await send('ROLLBACK', '50.00', 'rb-win', { reference: 'win-1' });
    expect(balance()).toBe('100.00');
    await send('BET', '20.00', 'bet-2');
    await send('REFUND', '20.00', 'refund-2', { reference: 'bet-2' });
    await send('ROLLBACK', '20.00', 'rb-refund', { reference: 'refund-2' });
    expect(balance()).toBe('80.00');
  });

  test('reversal that would overdraw is rejected with a distinct failure code', async () => {
    await send('WIN', '50.00', 'win-1');
    await send('BET', '150.00', 'bet-1');
    expect(balance()).toBe('0.00');
    const rollback = tx(await send('ROLLBACK', '50.00', 'rb-1', { reference: 'win-1' }));
    expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    expect(rollback.failureCode).not.toBe(FailureCode.InsufficientFunds);
    expect(balance()).toBe('0.00');
  });

  test('reference must be in the same round', async () => {
    await send('BET', '10.00', 'bet-1', { round: 'round-1' });
    const refund = tx(await send('REFUND', '10.00', 'refund-1', { reference: 'bet-1', round: 'round-2' }));
    expect(refund.failureCode).toBe(FailureCode.ReferenceMismatch);
  });
});

describe('wallet/currency checks', () => {
  test('operation currency must match the wallet currency', async () => {
    const result = tx(await send('BET', '10.00', 'bet-usd', { currency: 'USD' }));
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(balance()).toBe('100.00');
  });

  test('wallet of another player is rejected without leaking its balance', async () => {
    const result = tx(await send('BET', '10.00', 'bet-1', { playerId: 'intruder' }));
    expect(result.failureCode).toBe(FailureCode.WalletPlayerMismatch);
    expect(result.balanceAfter).toBeUndefined();
  });

  test('unknown wallet → WALLET_NOT_FOUND (not persisted, event emitted)', async () => {
    const result = await send('BET', '10.00', 'bet-1', { wallet: '0192f298-0000-7000-8000-ffffffffffff' });
    expect(result.type).toBe('wallet-not-found');
    expect(store.events('WagerTransactionRejected')).toHaveLength(1);
  });
});

describe('idempotency', () => {
  test('identical request → original result, including the balance observed at that time', async () => {
    const first = tx(await send('BET', '10.00', 'bet-1'));
    await send('BET', '30.00', 'bet-2');
    const replay = await send('BET', '10.00', 'bet-1');
    expect(replay.type).toBe('transaction');
    if (replay.type !== 'transaction') return;
    expect(replay.replay).toBe(true);
    expect(replay.transaction.id).toBe(first.id);
    expect(replay.transaction.balanceAfter?.toJSON().amount).toBe('90.00');
    expect(balance()).toBe('60.00');
    expect(ledgerCount()).toBe(3);
  });

  test('same key with a different payload is a conflict, never a replay', async () => {
    await send('BET', '10.00', 'bet-1');
    await expect(send('BET', '10.01', 'bet-1')).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(balance()).toBe('90.00');
  });

  test('same externalTransactionId under another key is a conflict', async () => {
    await send('BET', '10.00', 'bet-1', { key: 'key-1' });
    const error = await send('BET', '10.00', 'bet-1', { key: 'key-2' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IdempotencyConflictError);
    expect((error as IdempotencyConflictError).code).toBe('EXTERNAL_TRANSACTION_ID_CONFLICT');
  });

  test('same key committed between the key lookup and the external-id lookup is a replay (READ COMMITTED race)', async () => {
    const first = tx(await send('BET', '10.00', 'bet-race'));
    // The key lookup "ran before" the concurrent commit; the external-id lookup "after" it.
    const racingUow: UnitOfWork = {
      run: (work) =>
        new InMemoryUnitOfWork(store).run((repos) =>
          work({ ...repos, transactions: { ...repos.transactions, findByIdempotencyKey: async () => null } }),
        ),
    };
    const racing = new SubmitWagerTransactionUseCase(
      racingUow,
      new WagerTransactionProcessor(sequentialIds, new ReferenceRetryPolicy({ baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 1, ttlMs: 1 })),
      sequentialIds,
      clock,
      noopMetrics,
      silentLogger,
      { lockTimeoutMs: 1_000, maxConflictRetries: 1 },
    );
    const payload = {
      providerId: 'provider-a',
      externalTransactionId: 'bet-race',
      playerId: PLAYER,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    };
    const replay = await racing.execute(parseSubmitWagerTransactionCommand(payload, 'provider-a:bet-race'), {
      source: 'http',
      correlationId: 'c',
    });
    expect(replay.type === 'transaction' && replay.replay && replay.transaction.id).toBe(first.id);
    const conflict = await racing
      .execute(parseSubmitWagerTransactionCommand({ ...payload, money: { amount: '11.00', currency: 'BRL' } }, 'provider-a:bet-race'), {
        source: 'http',
        correlationId: 'c',
      })
      .catch((error: unknown) => error);
    expect((conflict as IdempotencyConflictError).code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect(balance()).toBe('90.00');
  });

  test('rejected transactions replay their rejection', async () => {
    const first = tx(await send('BET', '500.00', 'bet-1'));
    const replay = await send('BET', '500.00', 'bet-1');
    expect(replay.type === 'transaction' && replay.replay && replay.transaction.id === first.id).toBe(true);
    expect(replay.type === 'transaction' && replay.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test('inbox: same messageId is applied once; same messageId with another payload is a conflict', async () => {
    const inbox = { consumerName: 'c', messageId: 'm-1', payloadHash: 'a'.repeat(64) };
    await send('BET', '10.00', 'bet-1', { options: { source: 'sqs', inbox } });
    const duplicate = await send('BET', '10.00', 'bet-1', { options: { source: 'sqs', inbox } });
    expect(duplicate.type).toBe('duplicate-message');
    await expect(
      send('BET', '10.00', 'bet-1', { options: { source: 'sqs', inbox: { ...inbox, payloadHash: 'b'.repeat(64) } } }),
    ).rejects.toBeInstanceOf(InboxConflictError);
    expect(balance()).toBe('90.00');
  });
});

describe('out-of-order references', () => {
  test('ROLLBACK before its BET waits as PENDING_REFERENCE and is applied after the BET', async () => {
    const rollback = tx(await send('ROLLBACK', '10.00', 'rb-1', { reference: 'bet-1' }));
    expect(rollback.status).toBe(WagerTransactionStatus.PendingReference);
    expect(store.events('WagerTransactionPendingReference')).toHaveLength(1);
    expect(balance()).toBe('100.00');

    await send('BET', '10.00', 'bet-1');
    expect(balance()).toBe('90.00');
    const summary = await resolver.runOnce();
    expect(summary.processed).toBe(1);
    const resolved = store.transactions.get(rollback.id);
    expect(resolved?.status).toBe(WagerTransactionStatus.Processed);
    expect(balance()).toBe('100.00');
  });

  test('reference that never arrives → REJECTED REFERENCE_NOT_FOUND after the retry budget', async () => {
    const refund = tx(await send('REFUND', '10.00', 'refund-1', { reference: 'never' }));
    for (let i = 0; i < 5; i += 1) {
      clock.advance(10_000);
      await resolver.runOnce();
    }
    const final = store.transactions.get(refund.id);
    expect(final?.status).toBe(WagerTransactionStatus.Rejected);
    expect(final?.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(final?.referenceAttempts).toBe(2);
    expect(store.events('WagerTransactionRejected').some((e) => e.aggregateId === refund.id)).toBe(true);
    expect(balance()).toBe('100.00');
  });

  test('worker does nothing before the scheduled time', async () => {
    await send('REFUND', '10.00', 'refund-1', { reference: 'later' });
    expect((await resolver.runOnce()).examined).toBe(0);
  });
});
