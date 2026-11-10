import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { v7 as uuidv7 } from 'uuid';
import { parseSubmitWagerTransactionCommand } from '../../src/application/commands/submit-wager-transaction.command';
import { ProcessingFailedError } from '../../src/application/errors';
import type { TransactionalRepositories, UnitOfWork, UnitOfWorkOptions } from '../../src/application/ports/repositories';
import { SubmitWagerTransactionUseCase } from '../../src/application/use-cases/submit-wager-transaction.use-case';
import { ReferenceRetryPolicy } from '../../src/application/wagering/reference-retry-policy';
import { WagerTransactionProcessor } from '../../src/application/wagering/wager-transaction-processor';
import { TOKENS } from '../../src/app.tokens';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { systemClock, uuidV7Generator } from '../../src/infrastructure/runtime';
import { wagerPayload } from '../support/api';
import { startApp } from '../support/app';
import { prepareDatabase, scalar } from '../support/database';
import { uniqueQueues } from '../support/env';
import { noopMetrics, silentLogger } from '../support/in-memory-repositories';
import { assertGlobalInvariants, walletState } from '../support/invariants';

type FailurePoint = 'ledger-append' | 'outbox-enqueue' | 'inbox-mark-processed' | 'skip-wallet-update' | 'none';

/** Real PostgreSQL unit of work whose repositories fail at a chosen step. */
class FaultyUnitOfWork implements UnitOfWork {
  constructor(
    private readonly inner: UnitOfWork,
    public failAt: FailurePoint,
  ) {}

  run<T>(work: (repos: TransactionalRepositories) => Promise<T>, options?: UnitOfWorkOptions): Promise<T> {
    return this.inner.run((repos) => work(this.wrap(repos)), options);
  }

  private wrap(repos: TransactionalRepositories): TransactionalRepositories {
    const boom = (step: string) => async () => {
      throw new Error(`injected failure at ${step}`);
    };
    const failAt = this.failAt;
    return {
      wallets: {
        findById: (id) => repos.wallets.findById(id),
        lockById: (id) => repos.wallets.lockById(id),
        insert: (wallet) => repos.wallets.insert(wallet),
        // Simulates a buggy code path that forgets to update the materialized balance.
        saveBalance: failAt === 'skip-wallet-update' ? async () => undefined : (w, v) => repos.wallets.saveBalance(w, v),
      },
      transactions: repos.transactions,
      ledger: {
        append: failAt === 'ledger-append' ? boom('ledger') : (entry) => repos.ledger.append(entry),
        listByWallet: (id, page) => repos.ledger.listByWallet(id, page),
        summarize: (id, currency) => repos.ledger.summarize(id, currency),
      },
      inbox: {
        register: (message) => repos.inbox.register(message),
        markProcessed: failAt === 'inbox-mark-processed' ? boom('inbox') : (message) => repos.inbox.markProcessed(message),
      },
      outbox: {
        enqueue: failAt === 'outbox-enqueue' ? boom('outbox') : (messages) => repos.outbox.enqueue(messages),
        claimDue: (now, limit) => repos.outbox.claimDue(now, limit),
        save: (message) => repos.outbox.save(message),
        stats: () => repos.outbox.stats(),
      },
    };
  }
}

let app: Awaited<ReturnType<typeof startApp>>;
let uow: FaultyUnitOfWork;
let useCase: SubmitWagerTransactionUseCase;

beforeAll(async () => {
  await prepareDatabase();
  app = await startApp({ ...uniqueQueues('atomicity') });
  const orm = app.app.get<MikroORM>(TOKENS.orm);
  uow = new FaultyUnitOfWork(new MikroOrmUnitOfWork(orm), 'none');
  useCase = new SubmitWagerTransactionUseCase(
    uow,
    new WagerTransactionProcessor(
      uuidV7Generator,
      new ReferenceRetryPolicy({ baseDelayMs: 1000, maxDelayMs: 1000, maxAttempts: 3, ttlMs: 60_000 }),
    ),
    uuidV7Generator,
    systemClock,
    noopMetrics,
    silentLogger,
    { lockTimeoutMs: 2000, maxConflictRetries: 3 },
  );
});

afterAll(async () => {
  await app?.close();
  await assertGlobalInvariants();
});

async function rowCounts(walletId: string, idempotencyKey: string, messageId: string) {
  return {
    transactions: await scalar<number>(
      'SELECT COUNT(*)::int FROM wager_transactions WHERE provider_id = $1 AND idempotency_key = $2',
      ['provider-a', idempotencyKey],
    ),
    inbox: await scalar<number>('SELECT COUNT(*)::int FROM inbox_messages WHERE message_id = $1', [messageId]),
    outbox: await scalar<number>(`SELECT COUNT(*)::int FROM outbox_messages WHERE payload->'data'->>'walletId' = $1 AND event_type <> 'WalletBalanceChanged' AND payload->'data'->>'kind' = 'BET'`, [walletId]),
    wallet: await walletState(walletId),
  };
}

describe('inbox + transaction + ledger + wallet + outbox are one SQL transaction', () => {
  for (const failAt of ['ledger-append', 'outbox-enqueue', 'inbox-mark-processed'] as const) {
    test(`failure at ${failAt} leaves no trace; the redelivery then applies exactly once`, async () => {
      const { walletId, playerId } = await app.api.createWallet('100.00');
      const payload = wagerPayload(walletId, playerId, { amount: '30.00' });
      const command = parseSubmitWagerTransactionCommand(payload, `provider-a:${payload.externalTransactionId}`);
      const messageId = `msg-${uuidv7()}`;
      const options = {
        source: 'sqs' as const,
        correlationId: messageId,
        inbox: { consumerName: 'atomicity-test', messageId, payloadHash: 'f'.repeat(64) },
      };

      uow.failAt = failAt;
      await expect(useCase.execute(command, options)).rejects.toThrow('injected failure');
      expect(await rowCounts(walletId, command.idempotencyKey, messageId)).toEqual({
        transactions: 0,
        inbox: 0,
        outbox: 0,
        wallet: { balance: '100.00', version: 1, entries: 1, debits: 0 },
      });

      uow.failAt = 'none';
      const result = await useCase.execute(command, options);
      expect(result.type).toBe('transaction');
      const duplicate = await useCase.execute(command, options);
      expect(duplicate.type).toBe('duplicate-message');
      expect(await rowCounts(walletId, command.idempotencyKey, messageId)).toEqual({
        transactions: 1,
        inbox: 1,
        outbox: 1,
        wallet: { balance: '70.00', version: 2, entries: 2, debits: 1 },
      });
    });
  }

  test('a code path that forgets the wallet update is stopped by the deferred DB check and recorded as FAILED', async () => {
    const { walletId, playerId } = await app.api.createWallet('100.00');
    const payload = wagerPayload(walletId, playerId, { amount: '30.00' });
    const command = parseSubmitWagerTransactionCommand(payload, `provider-a:${payload.externalTransactionId}`);

    uow.failAt = 'skip-wallet-update';
    const error = await useCase.execute(command, { source: 'http', correlationId: 'c' }).catch((e: unknown) => e);
    uow.failAt = 'none';
    expect(error).toBeInstanceOf(ProcessingFailedError);
    expect(await walletState(walletId)).toEqual({ balance: '100.00', version: 1, entries: 1, debits: 0 });
    expect(
      await scalar('SELECT status || \':\' || failure_code FROM wager_transactions WHERE id = $1', [
        (error as ProcessingFailedError).transactionId,
      ]),
    ).toBe('FAILED:PROCESSING_FAILED');

    // FAILED is terminal for that key: a replay returns it, it is never re-applied.
    const replay = await useCase.execute(command, { source: 'http', correlationId: 'c' });
    expect(replay.type === 'transaction' && replay.replay ? String(replay.transaction.status) : 'none').toBe('FAILED');
    expect((await walletState(walletId)).balance).toBe('100.00');
  });
});
