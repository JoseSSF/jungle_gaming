import { ConcurrencyConflictError, WalletAlreadyExistsError } from '../../src/application/errors';
import type {
  InboxRegistration,
  InboxRepository,
  LedgerPage,
  LedgerRepository,
  LedgerSummary,
  OutboxRepository,
  OutboxStats,
  PendingReferenceCandidate,
  TransactionalRepositories,
  UnitOfWork,
  WagerTransactionRepository,
  WalletRepository,
} from '../../src/application/ports/repositories';
import type { Clock, IdGenerator, Logger, WageringMetrics } from '../../src/application/ports/runtime';
import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { Money } from '../../src/domain/money/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../src/domain/wallet/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger-entry';

/*
 * In-memory adapters for *unit* tests of the application rules only. They store
 * snapshots (rehydrated copies) so that aggregates mutated by a failed unit of work never
 * leak into the store. Integration and concurrency suites always use PostgreSQL + SQS.
 */

const cloneWallet = (w: Wallet) =>
  Wallet.rehydrate({
    id: w.id,
    playerId: w.playerId,
    currency: w.currency,
    balance: w.balance,
    version: w.version,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  });

const cloneTx = (t: WagerTransaction) =>
  WagerTransaction.rehydrate({
    id: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    idempotencyKey: t.idempotencyKey,
    payloadHash: t.payloadHash,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    money: t.money,
    referenceExternalTransactionId: t.referenceExternalTransactionId,
    correlationId: t.correlationId,
    createdAt: t.createdAt,
    status: t.status,
    referenceTransactionId: t.referenceTransactionId,
    failureCode: t.failureCode,
    processedAt: t.processedAt,
    balanceAfter: t.balanceAfter,
    referenceAttempts: t.referenceAttempts,
    nextReferenceCheckAt: t.nextReferenceCheckAt,
    updatedAt: t.updatedAt,
  });

export class InMemoryStore {
  wallets = new Map<string, Wallet>();
  transactions = new Map<string, WagerTransaction>();
  ledger: WalletLedgerEntry[] = [];
  inbox = new Map<string, InboxMessage>();
  outbox = new Map<string, OutboxMessage>();

  snapshot(): InMemoryStore {
    const copy = new InMemoryStore();
    for (const [id, w] of this.wallets) copy.wallets.set(id, cloneWallet(w));
    for (const [id, t] of this.transactions) copy.transactions.set(id, cloneTx(t));
    copy.ledger = [...this.ledger];
    copy.inbox = new Map(
      [...this.inbox].map(([key, message]) => [
        key,
        InboxMessage.rehydrate({
          messageId: message.messageId,
          consumerName: message.consumerName,
          payloadHash: message.payloadHash,
          receivedAt: message.receivedAt,
          processedAt: message.processedAt,
        }),
      ]),
    );
    copy.outbox = new Map(this.outbox);
    return copy;
  }

  balanceFromLedger(walletId: string, currency = 'BRL'): Money {
    return this.ledger
      .filter((entry) => entry.walletId === walletId)
      .reduce((sum, entry) => sum.add(entry.signedAmount()), Money.zero(currency));
  }

  events(type?: string): OutboxMessage[] {
    return [...this.outbox.values()].filter((message) => !type || message.eventType === type);
  }
}

class Repos implements TransactionalRepositories {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;

  constructor(store: InMemoryStore) {
    this.wallets = {
      findById: async (id) => (store.wallets.has(id) ? cloneWallet(store.wallets.get(id) as Wallet) : null),
      lockById: async (id) => (store.wallets.has(id) ? cloneWallet(store.wallets.get(id) as Wallet) : null),
      insert: async (wallet) => {
        for (const existing of store.wallets.values()) {
          if (existing.playerId === wallet.playerId && existing.currency === wallet.currency) {
            throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
          }
        }
        store.wallets.set(wallet.id, cloneWallet(wallet));
      },
      saveBalance: async (wallet, expectedVersion) => {
        const current = store.wallets.get(wallet.id);
        if (!current || current.version !== expectedVersion) {
          throw new ConcurrencyConflictError('version-mismatch', 'version mismatch');
        }
        store.wallets.set(wallet.id, cloneWallet(wallet));
      },
    };
    const all = () => [...store.transactions.values()];
    this.transactions = {
      findById: async (id) => (store.transactions.has(id) ? cloneTx(store.transactions.get(id) as WagerTransaction) : null),
      findByIdempotencyKey: async (providerId, key) => {
        const found = all().find((t) => t.providerId === providerId && t.idempotencyKey === key);
        return found ? cloneTx(found) : null;
      },
      findByExternalId: async (providerId, externalId) => {
        const found = all().find((t) => t.providerId === providerId && t.externalTransactionId === externalId);
        return found ? cloneTx(found) : null;
      },
      hasProcessedReversal: async (referenceId) =>
        all().some(
          (t) =>
            t.referenceTransactionId === referenceId &&
            t.status === WagerTransactionStatus.Processed &&
            (t.kind === WagerTransactionKind.Refund || t.kind === WagerTransactionKind.Rollback),
        ),
      insert: async (tx) => {
        if (all().some((t) => t.providerId === tx.providerId && (t.idempotencyKey === tx.idempotencyKey || t.externalTransactionId === tx.externalTransactionId))) {
          throw new ConcurrencyConflictError('unique-race', 'duplicate');
        }
        store.transactions.set(tx.id, cloneTx(tx));
      },
      update: async (tx) => {
        store.transactions.set(tx.id, cloneTx(tx));
      },
      findDuePendingReferences: async (now, limit): Promise<PendingReferenceCandidate[]> =>
        all()
          .filter((t) => t.isReferenceCheckDue(now))
          .slice(0, limit)
          .map((t) => ({ id: t.id, walletId: t.walletId })),
      expediteDependents: async (providerId, externalId, now) => {
        let count = 0;
        for (const t of all()) {
          if (
            t.providerId === providerId &&
            t.referenceExternalTransactionId === externalId &&
            t.status === WagerTransactionStatus.PendingReference
          ) {
            store.transactions.set(t.id, WagerTransaction.rehydrate({ ...stateOf(t), nextReferenceCheckAt: now }));
            count += 1;
          }
        }
        return count;
      },
    };
    this.ledger = {
      append: async (entry) => {
        const last = store.ledger.filter((e) => e.walletId === entry.walletId).at(-1);
        if (last && entry.walletVersion !== last.walletVersion + 1) throw new Error('ledger chain broken');
        store.ledger.push(entry);
      },
      listByWallet: async (walletId, page: LedgerPage) =>
        store.ledger
          .filter((e) => e.walletId === walletId && (page.beforeVersion === undefined || e.walletVersion < page.beforeVersion))
          .sort((a, b) => b.walletVersion - a.walletVersion)
          .slice(0, page.limit),
      summarize: async (walletId, currency): Promise<LedgerSummary> => {
        const entries = store.ledger.filter((e) => e.walletId === walletId);
        const sum = (direction: LedgerDirection) =>
          entries.filter((e) => e.direction === direction).reduce((acc, e) => acc.add(e.money), Money.zero(currency));
        return {
          currency,
          totalCredits: sum(LedgerDirection.Credit).toDecimalString(),
          totalDebits: sum(LedgerDirection.Debit).toDecimalString(),
          entries: entries.length,
        };
      },
    };
    this.inbox = {
      register: async (message): Promise<InboxRegistration> => {
        const key = `${message.consumerName}/${message.messageId}`;
        const existing = store.inbox.get(key);
        if (existing) return { registered: false, existing };
        store.inbox.set(key, message);
        return { registered: true };
      },
      markProcessed: async (message) => {
        store.inbox.set(`${message.consumerName}/${message.messageId}`, message);
      },
    };
    this.outbox = {
      enqueue: async (messages) => {
        for (const message of messages) store.outbox.set(message.id, message);
      },
      claimDue: async (now, limit) => [...store.outbox.values()].filter((m) => m.isDue(now)).slice(0, limit),
      save: async (message) => {
        store.outbox.set(message.id, message);
      },
      stats: async (): Promise<OutboxStats> => {
        const pending = [...store.outbox.values()].filter((m) => m.isPending());
        return { pending: pending.length, oldestPendingOccurredAt: pending[0]?.occurredAt ?? null };
      },
    };
  }
}

function stateOf(t: WagerTransaction) {
  return {
    id: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    idempotencyKey: t.idempotencyKey,
    payloadHash: t.payloadHash,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    money: t.money,
    referenceExternalTransactionId: t.referenceExternalTransactionId,
    correlationId: t.correlationId,
    createdAt: t.createdAt,
    status: t.status,
    referenceTransactionId: t.referenceTransactionId,
    failureCode: t.failureCode,
    processedAt: t.processedAt,
    balanceAfter: t.balanceAfter,
    referenceAttempts: t.referenceAttempts,
    nextReferenceCheckAt: t.nextReferenceCheckAt,
    updatedAt: t.updatedAt,
  };
}

/** Runs units of work sequentially against a snapshot; commits by swapping the store. */
export class InMemoryUnitOfWork implements UnitOfWork {
  constructor(public store: InMemoryStore) {}

  async run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    const draft = this.store.snapshot();
    const result = await work(new Repos(draft));
    this.store.wallets = draft.wallets;
    this.store.transactions = draft.transactions;
    this.store.ledger = draft.ledger;
    this.store.inbox = draft.inbox;
    this.store.outbox = draft.outbox;
    return result;
  }
}

export class ManualClock implements Clock {
  constructor(private current = new Date('2026-07-29T15:00:00.000Z')) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

let counter = 0;
export const sequentialIds: IdGenerator = {
  next: () => {
    counter += 1;
    const hex = counter.toString(16).padStart(12, '0');
    return `0192f298-0000-7000-8000-${hex}`;
  },
};

export const silentLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

export const noopMetrics: WageringMetrics = {
  transactionCompleted: () => {},
  duplicateDetected: () => {},
  idempotencyConflict: () => {},
  retry: () => {},
  concurrencyConflict: () => {},
  lockWaitSeconds: () => {},
  processingSeconds: () => {},
  pendingReferenceResolution: () => {},
  reconciliation: () => {},
  outboxPublished: () => {},
  outboxPublishFailed: () => {},
  outboxBacklog: () => {},
};
