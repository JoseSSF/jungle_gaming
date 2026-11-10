import { WagerTransactionFailed, WagerTransactionRejected } from '../../domain/events/wagering-events';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { DomainError } from '../../domain/shared/domain-error';
import { FailureCode } from '../../domain/wagering/failure-code';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { SubmitWagerTransactionCommand } from '../commands/submit-wager-transaction.command';
import {
  ApplicationError,
  ConcurrencyConflictError,
  IdempotencyConflictError,
  InboxConflictError,
  PersistenceInvariantError,
  ProcessingFailedError,
} from '../errors';
import type { TransactionalRepositories, UnitOfWork } from '../ports/repositories';
import type { Clock, IdGenerator, Logger, TransactionSource, WageringMetrics } from '../ports/runtime';
import { withRetry } from '../support/retry';
import type { WagerTransactionProcessor } from '../wagering/wager-transaction-processor';

export interface InboxContext {
  consumerName: string;
  messageId: string;
  /** Hash of the whole message (type + data), used to detect messageId reuse. */
  payloadHash: string;
}

export interface SubmitOptions {
  source: TransactionSource;
  correlationId: string;
  causationId?: string;
  /** Present when the request comes from the broker: registered in the same SQL transaction. */
  inbox?: InboxContext;
}

export type SubmitResult =
  | { readonly type: 'transaction'; readonly transaction: WagerTransaction; readonly replay: boolean }
  | { readonly type: 'wallet-not-found'; readonly failureCode: FailureCode.WalletNotFound }
  | { readonly type: 'duplicate-message' };

export interface SubmitWagerTransactionConfig {
  lockTimeoutMs: number;
  maxConflictRetries: number;
}

/**
 * The single wager use case, shared by HTTP and SQS.
 *
 * Inside ONE SQL transaction:
 *   inbox register → idempotency lookup → wallet row lock (FOR UPDATE) → idempotency
 *   re-check → apply rules → transaction row → ledger entry → wallet (version-guarded)
 *   → outbox events → inbox processed.
 *
 * Lost races (lock timeout, deadlock, unique violation, version mismatch) roll the whole
 * transaction back and are retried with backoff; the database constraints remain the
 * final arbiter of every invariant.
 */
export class SubmitWagerTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly processor: WagerTransactionProcessor,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly metrics: WageringMetrics,
    private readonly logger: Logger,
    private readonly config: SubmitWagerTransactionConfig,
  ) {}

  async execute(command: SubmitWagerTransactionCommand, options: SubmitOptions): Promise<SubmitResult> {
    const startedAt = performance.now();
    let outcome = 'error';
    try {
      const result = await withRetry(() => this.attempt(command, options), {
        maxAttempts: this.config.maxConflictRetries,
        baseDelayMs: 10,
        maxDelayMs: 250,
        isRetryable: (error) => error instanceof ConcurrencyConflictError,
        onRetry: (error, attempt) => {
          const reason = (error as ConcurrencyConflictError).reason;
          this.metrics.concurrencyConflict(reason);
          this.metrics.retry('submit-wager-transaction', reason);
          this.logger.debug('wager_transaction_retry', { attempt, reason });
        },
      });
      outcome = this.recordOutcome(command, options, result);
      return result;
    } catch (error) {
      outcome = error instanceof ApplicationError ? error.code : 'unexpected';
      if (error instanceof IdempotencyConflictError || error instanceof InboxConflictError) {
        this.metrics.idempotencyConflict(options.source);
        this.logger.warn('wager_transaction_idempotency_conflict', {
          code: error.code,
          providerId: command.providerId,
          walletId: command.walletId,
        });
      }
      if (error instanceof ConcurrencyConflictError) {
        this.metrics.concurrencyConflict(error.reason);
      }
      if (isPermanentProcessingError(error)) {
        throw await this.recordPermanentFailure(command, options, error);
      }
      throw error;
    } finally {
      this.metrics.processingSeconds(options.source, outcome, (performance.now() - startedAt) / 1000);
    }
  }

  private attempt(command: SubmitWagerTransactionCommand, options: SubmitOptions): Promise<SubmitResult> {
    return this.uow.run(
      async (repos) => {
        const now = this.clock.now();
        let inboxMessage: InboxMessage | undefined;
        if (options.inbox) {
          inboxMessage = InboxMessage.receive({ ...options.inbox, receivedAt: now });
          const registration = await repos.inbox.register(inboxMessage);
          if (!registration.registered) {
            if (registration.existing.payloadHash !== options.inbox.payloadHash) {
              throw new InboxConflictError(options.inbox.messageId);
            }
            return { type: 'duplicate-message' } as const;
          }
        }

        const result = await this.decide(repos, command, options, now);

        if (inboxMessage) {
          inboxMessage.markProcessed(now);
          await repos.inbox.markProcessed(inboxMessage);
        }
        return result;
      },
      { lockTimeoutMs: this.config.lockTimeoutMs },
    );
  }

  private async decide(
    repos: TransactionalRepositories,
    command: SubmitWagerTransactionCommand,
    options: SubmitOptions,
    now: Date,
  ): Promise<SubmitResult> {
    // Fast path: replays never wait for the wallet lock.
    const replay = await this.findReplay(repos, command);
    if (replay) return replay;

    const lockStartedAt = performance.now();
    const wallet = await repos.wallets.lockById(command.walletId);
    this.metrics.lockWaitSeconds((performance.now() - lockStartedAt) / 1000);

    if (!wallet) {
      await repos.outbox.enqueue([
        OutboxMessage.enqueue(
          WagerTransactionRejected.unpersisted(
            {
              providerId: command.providerId,
              externalTransactionId: command.externalTransactionId,
              walletId: command.walletId,
              kind: command.kind,
              money: command.money.toJSON(),
              failureCode: FailureCode.WalletNotFound,
            },
            { eventId: this.ids.next(), correlationId: options.correlationId, causationId: options.causationId, occurredAt: now },
          ),
        ),
      ]);
      return { type: 'wallet-not-found', failureCode: FailureCode.WalletNotFound };
    }

    // Authoritative re-check: every writer of this wallet is now serialized behind our lock.
    const replayUnderLock = await this.findReplay(repos, command);
    if (replayUnderLock) return replayUnderLock;

    const tx = this.newTransaction(command, options, now);
    await this.processor.process(repos, wallet, tx, 'insert', {
      now,
      correlationId: options.correlationId,
      causationId: options.causationId,
    });
    return { type: 'transaction', transaction: tx, replay: false };
  }

  private async findReplay(
    repos: TransactionalRepositories,
    command: SubmitWagerTransactionCommand,
  ): Promise<SubmitResult | null> {
    const existing = await repos.transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey);
    if (existing) {
      if (!existing.matchesPayload(command.payloadHash)) {
        throw new IdempotencyConflictError(
          'IDEMPOTENCY_KEY_CONFLICT',
          'Idempotency-Key was already used with a different payload',
          existing.id,
        );
      }
      return { type: 'transaction', transaction: existing, replay: true };
    }
    const sameExternalId = await repos.transactions.findByExternalId(command.providerId, command.externalTransactionId);
    if (sameExternalId) {
      throw new IdempotencyConflictError(
        'EXTERNAL_TRANSACTION_ID_CONFLICT',
        'externalTransactionId was already submitted under another Idempotency-Key',
        sameExternalId.id,
      );
    }
    return null;
  }

  private newTransaction(command: SubmitWagerTransactionCommand, options: SubmitOptions, now: Date): WagerTransaction {
    return WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: command.payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      correlationId: options.correlationId,
      createdAt: now,
    });
  }

  private recordOutcome(command: SubmitWagerTransactionCommand, options: SubmitOptions, result: SubmitResult): string {
    switch (result.type) {
      case 'duplicate-message':
        this.metrics.duplicateDetected('inbox-message', options.source);
        this.logger.info('wager_message_duplicate', { providerId: command.providerId, walletId: command.walletId });
        return 'duplicate-message';
      case 'wallet-not-found':
        this.metrics.transactionCompleted(command.kind, 'REJECTED', options.source);
        this.logger.info('wager_transaction_rejected', {
          failureCode: result.failureCode,
          providerId: command.providerId,
          walletId: command.walletId,
        });
        return 'wallet-not-found';
      case 'transaction': {
        const tx = result.transaction;
        const fields = {
          transactionId: tx.id,
          walletId: tx.walletId,
          providerId: tx.providerId,
          kind: tx.kind,
          status: tx.status,
          failureCode: tx.failureCode,
        };
        if (result.replay) {
          this.metrics.duplicateDetected('idempotency-replay', options.source);
          this.logger.info('wager_transaction_replayed', fields);
          return 'replay';
        }
        this.metrics.transactionCompleted(tx.kind, tx.status, options.source);
        this.logger.info('wager_transaction_completed', fields);
        return tx.status;
      }
    }
  }

  /**
   * Records an auditable FAILED transaction for a permanent, non-business failure
   * (schema invariant refused the write, domain invariant broken = bug). Best effort.
   */
  private async recordPermanentFailure(
    command: SubmitWagerTransactionCommand,
    options: SubmitOptions,
    cause: unknown,
  ): Promise<Error> {
    this.logger.error('wager_transaction_permanent_failure', {
      providerId: command.providerId,
      walletId: command.walletId,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    try {
      const transactionId = await this.uow.run(async (repos) => {
        const wallet = await repos.wallets.lockById(command.walletId);
        if (!wallet) return undefined;
        const existing = await repos.transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey);
        if (existing) return existing.id;
        const now = this.clock.now();
        const tx = this.newTransaction(command, options, now);
        tx.fail(FailureCode.ProcessingFailed, now);
        await repos.transactions.insert(tx);
        await repos.outbox.enqueue([
          OutboxMessage.enqueue(
            WagerTransactionFailed.from(tx, {
              eventId: this.ids.next(),
              correlationId: options.correlationId,
              causationId: options.causationId,
              occurredAt: now,
            }),
          ),
        ]);
        this.metrics.transactionCompleted(tx.kind, tx.status, options.source);
        return tx.id;
      });
      return new ProcessingFailedError('Transaction could not be processed', transactionId, { cause });
    } catch (recordError) {
      this.logger.error('wager_transaction_failure_not_recorded', {
        error: recordError instanceof Error ? recordError.message : String(recordError),
      });
      return new ProcessingFailedError('Transaction could not be processed', undefined, { cause });
    }
  }
}

function isPermanentProcessingError(error: unknown): boolean {
  return error instanceof PersistenceInvariantError || error instanceof DomainError;
}
