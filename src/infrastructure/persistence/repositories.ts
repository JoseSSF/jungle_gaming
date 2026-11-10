import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { ConcurrencyConflictError, WalletAlreadyExistsError } from '../../application/errors';
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
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports/repositories';
import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { isUniqueViolation } from './database-errors';
import { InboxSchema, LedgerEntrySchema, OutboxSchema, WagerTransactionSchema, WalletSchema } from './entities';
import {
  inboxToDomain,
  ledgerEntryToDomain,
  ledgerEntryToRecord,
  outboxToDomain,
  outboxToRecord,
  transactionStateToRecord,
  transactionToDomain,
  transactionToRecord,
  walletToDomain,
  walletToRecord,
} from './mappers';

/*
 * Repositories issue explicit statements (em.insert / em.nativeUpdate / locked finds)
 * instead of relying on implicit flush ordering: the critical writes must be a
 * version-guarded UPDATE and happen in FK order inside the caller's transaction.
 * Reads bypass the identity map: every read inside a transaction must reflect the
 * latest committed state seen *after* the wallet lock was acquired.
 */
const fresh = { disableIdentityMap: true } as const;

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | null> {
    const record = await this.em.findOne(WalletSchema, { id }, fresh);
    return record ? walletToDomain(record) : null;
  }

  async lockById(id: string): Promise<Wallet | null> {
    const record = await this.em.findOne(WalletSchema, { id }, { ...fresh, lockMode: LockMode.PESSIMISTIC_WRITE });
    return record ? walletToDomain(record) : null;
  }

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(WalletSchema, walletToRecord(wallet));
    } catch (error) {
      if (isUniqueViolation(error, 'ux_wallets_player_currency')) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency, { cause: error });
      }
      throw error;
    }
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.toDecimalString(), version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) {
      throw new ConcurrencyConflictError(
        'version-mismatch',
        `Wallet ${wallet.id} changed concurrently (expected version ${expectedVersion})`,
      );
    }
  }
}

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(WagerTransactionSchema, { id }, fresh);
    return record ? transactionToDomain(record) : null;
  }

  async findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(WagerTransactionSchema, { providerId, idempotencyKey }, fresh);
    return record ? transactionToDomain(record) : null;
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(WagerTransactionSchema, { providerId, externalTransactionId }, fresh);
    return record ? transactionToDomain(record) : null;
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    });
    return count > 0;
  }

  async insert(tx: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionSchema, transactionToRecord(tx));
  }

  async update(tx: WagerTransaction): Promise<void> {
    const affected = await this.em.nativeUpdate(WagerTransactionSchema, { id: tx.id }, transactionStateToRecord(tx));
    if (affected !== 1) {
      throw new ConcurrencyConflictError('version-mismatch', `Wager transaction ${tx.id} vanished during update`);
    }
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<PendingReferenceCandidate[]> {
    const records = await this.em.find(
      WagerTransactionSchema,
      { status: WagerTransactionStatus.PendingReference, nextReferenceCheckAt: { $lte: now } },
      { ...fresh, orderBy: { nextReferenceCheckAt: 'asc' }, limit, fields: ['id', 'walletId'] },
    );
    return records.map((record) => ({ id: record.id, walletId: record.walletId }));
  }

  async expediteDependents(providerId: string, externalTransactionId: string, now: Date): Promise<number> {
    return this.em.nativeUpdate(
      WagerTransactionSchema,
      {
        providerId,
        referenceExternalTransactionId: externalTransactionId,
        status: WagerTransactionStatus.PendingReference,
        nextReferenceCheckAt: { $gt: now },
      },
      { nextReferenceCheckAt: now },
    );
  }
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, ledgerEntryToRecord(entry));
  }

  async listByWallet(walletId: string, page: LedgerPage): Promise<WalletLedgerEntry[]> {
    const where =
      page.beforeVersion === undefined ? { walletId } : { walletId, walletVersion: { $lt: page.beforeVersion } };
    const records = await this.em.find(LedgerEntrySchema, where, {
      ...fresh,
      orderBy: { walletVersion: 'desc' },
      limit: page.limit,
    });
    return records.map(ledgerEntryToDomain);
  }

  async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    // Sums are computed by PostgreSQL in numeric and returned as text: exact, no JS number.
    const rows = await this.em.execute<{ credits: string; debits: string; entries: number }[]>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)::numeric(20,2)::text AS credits,
              COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0)::numeric(20,2)::text  AS debits,
              COUNT(*)::int AS entries
         FROM wallet_ledger_entries
        WHERE wallet_id = ?`,
      [walletId],
    );
    const row = rows[0];
    return {
      currency,
      totalCredits: row?.credits ?? '0.00',
      totalDebits: row?.debits ?? '0.00',
      entries: Number(row?.entries ?? 0),
    };
  }
}

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async register(message: InboxMessage): Promise<InboxRegistration> {
    // A concurrent duplicate blocks on the unique index until the first transaction ends,
    // then sees the committed row (DO NOTHING) — or inserts if the first one rolled back.
    const inserted = await this.em.execute<{ message_id: string }[]>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
    );
    if (inserted.length === 1) return { registered: true };
    const existing = await this.em.findOneOrFail(
      InboxSchema,
      { consumerName: message.consumerName, messageId: message.messageId },
      fresh,
    );
    return { registered: false, existing: inboxToDomain(existing) };
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      InboxSchema,
      { consumerName: message.consumerName, messageId: message.messageId },
      { processedAt: message.processedAt ?? null },
    );
  }
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(OutboxSchema, messages.map(outboxToRecord));
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const records = await this.em.find(
      OutboxSchema,
      { publishedAt: null, $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
      { ...fresh, orderBy: { occurredAt: 'asc', id: 'asc' }, limit, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
    );
    return records.map(outboxToDomain);
  }

  async save(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxSchema,
      { id: message.id, publishedAt: null },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? null,
        publishedAt: message.publishedAt ?? null,
        lastError: message.lastError ?? null,
      },
    );
  }

  async stats(): Promise<OutboxStats> {
    const rows = await this.em.execute<{ pending: number; oldest: Date | string | null }[]>(
      'SELECT COUNT(*)::int AS pending, MIN(occurred_at) AS oldest FROM outbox_messages WHERE published_at IS NULL',
    );
    const row = rows[0];
    const oldest = row?.oldest ?? null;
    return {
      pending: Number(row?.pending ?? 0),
      oldestPendingOccurredAt: oldest === null ? null : new Date(oldest),
    };
  }
}

export class MikroOrmRepositories implements TransactionalRepositories {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;

  constructor(em: EntityManager) {
    this.wallets = new MikroOrmWalletRepository(em);
    this.transactions = new MikroOrmWagerTransactionRepository(em);
    this.ledger = new MikroOrmLedgerRepository(em);
    this.inbox = new MikroOrmInboxRepository(em);
    this.outbox = new MikroOrmOutboxRepository(em);
  }
}
