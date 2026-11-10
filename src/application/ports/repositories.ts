import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';

export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;
  /**
   * `SELECT ... FOR UPDATE` on the wallet row: the per-wallet serialization point.
   * Every writer of a wallet acquires this lock first (lock ordering: wallet → rows).
   */
  lockById(id: string): Promise<Wallet | null>;
  /** Throws WalletAlreadyExistsError on (playerId, currency) collision. */
  insert(wallet: Wallet): Promise<void>;
  /**
   * `UPDATE wallets ... WHERE id = ? AND version = ?` — optimistic guard on top of the
   * pessimistic lock (defense in depth). Throws ConcurrencyConflictError if 0 rows match.
   */
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface PendingReferenceCandidate {
  id: string;
  walletId: string;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  /** Whether a PROCESSED REFUND/ROLLBACK already targets the given transaction. */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  insert(tx: WagerTransaction): Promise<void>;
  /** Persists a state transition (status, reference resolution, retry schedule). */
  update(tx: WagerTransaction): Promise<void>;
  findDuePendingReferences(now: Date, limit: number): Promise<PendingReferenceCandidate[]>;
  /** Makes PENDING_REFERENCE transactions waiting for `externalTransactionId` due immediately. */
  expediteDependents(providerId: string, externalTransactionId: string, now: Date): Promise<number>;
}

export interface LedgerSummary {
  currency: string;
  /** Exact decimal strings computed by PostgreSQL (numeric). */
  totalCredits: string;
  totalDebits: string;
  entries: number;
}

export interface LedgerPage {
  /** Exclusive upper bound on walletVersion (keyset cursor). */
  beforeVersion?: number;
  limit: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  /** Newest first, keyset-paginated by walletVersion. */
  listByWallet(walletId: string, page: LedgerPage): Promise<WalletLedgerEntry[]>;
  summarize(walletId: string, currency: string): Promise<LedgerSummary>;
}

export type InboxRegistration = { registered: true } | { registered: false; existing: InboxMessage };

export interface InboxRepository {
  /** `INSERT ... ON CONFLICT DO NOTHING`: concurrent duplicates block until the first one commits. */
  register(message: InboxMessage): Promise<InboxRegistration>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface OutboxStats {
  pending: number;
  oldestPendingOccurredAt: Date | null;
}

export interface OutboxRepository {
  enqueue(messages: readonly OutboxMessage[]): Promise<void>;
  /** `FOR UPDATE SKIP LOCKED`: concurrent publishers never claim the same rows. */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  /** Persists markPublished / scheduleRetry. */
  save(message: OutboxMessage): Promise<void>;
  stats(): Promise<OutboxStats>;
}

export interface TransactionalRepositories {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
}

export interface UnitOfWorkOptions {
  isolation?: 'read-committed' | 'repeatable-read';
  readOnly?: boolean;
  /** `SET LOCAL lock_timeout`: bounded waiting on row locks, surfaces as ConcurrencyConflictError. */
  lockTimeoutMs?: number;
}

/**
 * One SQL transaction. Everything done through the given repositories commits or rolls
 * back together (inbox + transaction + ledger + wallet + outbox).
 * Implementations translate driver errors into application errors.
 */
export interface UnitOfWork {
  run<T>(work: (repos: TransactionalRepositories) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}
