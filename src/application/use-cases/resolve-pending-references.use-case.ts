import { WagerTransactionFailed } from '../../domain/events/wagering-events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { DomainError } from '../../domain/shared/domain-error';
import { FailureCode } from '../../domain/wagering/failure-code';
import { ConcurrencyConflictError, PersistenceInvariantError } from '../errors';
import type { UnitOfWork } from '../ports/repositories';
import type { Clock, IdGenerator, Logger, WageringMetrics } from '../ports/runtime';
import { withRetry } from '../support/retry';
import type { ProcessingOutcome, WagerTransactionProcessor } from '../wagering/wager-transaction-processor';

export interface ResolvePendingReferencesConfig {
  batchSize: number;
  lockTimeoutMs: number;
  maxConflictRetries: number;
}

export interface ResolutionSummary {
  examined: number;
  processed: number;
  rejected: number;
  rescheduled: number;
  skipped: number;
  failed: number;
}

/**
 * Scheduled worker step for PENDING_REFERENCE transactions (out-of-order delivery).
 *
 * Candidates are selected without locks; each one is then handled in its own SQL
 * transaction that first locks the wallet (same lock as the synchronous path) and
 * re-reads the transaction. Several instances can run this concurrently: the loser of a
 * race simply finds the transaction no longer due and skips it.
 */
export class ResolvePendingReferencesUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly processor: WagerTransactionProcessor,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly metrics: WageringMetrics,
    private readonly logger: Logger,
    private readonly config: ResolvePendingReferencesConfig,
  ) {}

  async runOnce(): Promise<ResolutionSummary> {
    const summary: ResolutionSummary = { examined: 0, processed: 0, rejected: 0, rescheduled: 0, skipped: 0, failed: 0 };
    const candidates = await this.uow.run(
      (repos) => repos.transactions.findDuePendingReferences(this.clock.now(), this.config.batchSize),
      { readOnly: true },
    );

    for (const candidate of candidates) {
      summary.examined += 1;
      try {
        const outcome = await this.resolve(candidate.id, candidate.walletId);
        summary[outcomeKey(outcome)] += 1;
      } catch (error) {
        if (error instanceof PersistenceInvariantError || error instanceof DomainError) {
          summary.failed += 1;
          await this.markFailed(candidate.id, candidate.walletId, error);
        } else {
          // Transient: left untouched, it will be picked up again on a later run.
          this.logger.warn('pending_reference_resolution_deferred', {
            transactionId: candidate.id,
            walletId: candidate.walletId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return summary;
  }

  private async resolve(transactionId: string, walletId: string): Promise<ProcessingOutcome | 'skipped'> {
    const outcome = await withRetry(
      () =>
        this.uow.run(
          async (repos) => {
            const now = this.clock.now();
            const wallet = await repos.wallets.lockById(walletId);
            if (!wallet) return 'skipped' as const;
            const tx = await repos.transactions.findById(transactionId);
            if (!tx || !tx.isReferenceCheckDue(now)) return 'skipped' as const;
            const result = await this.processor.process(repos, wallet, tx, 'update', {
              now,
              correlationId: tx.correlationId,
              causationId: tx.id,
            });
            if (result === 'processed' || result === 'rejected') {
              this.metrics.transactionCompleted(tx.kind, tx.status, 'worker');
              this.logger.info('pending_reference_resolved', {
                transactionId: tx.id,
                walletId: tx.walletId,
                providerId: tx.providerId,
                status: tx.status,
                failureCode: tx.failureCode,
              });
            }
            return result;
          },
          { lockTimeoutMs: this.config.lockTimeoutMs },
        ),
      {
        maxAttempts: this.config.maxConflictRetries,
        baseDelayMs: 10,
        maxDelayMs: 250,
        isRetryable: (error) => error instanceof ConcurrencyConflictError,
        onRetry: (error) => {
          const reason = (error as ConcurrencyConflictError).reason;
          this.metrics.concurrencyConflict(reason);
          this.metrics.retry('resolve-pending-reference', reason);
        },
      },
    );
    this.metrics.pendingReferenceResolution(outcome);
    return outcome;
  }

  private async markFailed(transactionId: string, walletId: string, cause: unknown): Promise<void> {
    this.logger.error('pending_reference_permanent_failure', {
      transactionId,
      walletId,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    try {
      await this.uow.run(async (repos) => {
        const now = this.clock.now();
        await repos.wallets.lockById(walletId);
        const tx = await repos.transactions.findById(transactionId);
        if (!tx || tx.isTerminal()) return;
        tx.fail(FailureCode.ProcessingFailed, now);
        await repos.transactions.update(tx);
        await repos.outbox.enqueue([
          OutboxMessage.enqueue(
            WagerTransactionFailed.from(tx, {
              eventId: this.ids.next(),
              correlationId: tx.correlationId,
              causationId: tx.id,
              occurredAt: now,
            }),
          ),
        ]);
        this.metrics.transactionCompleted(tx.kind, tx.status, 'worker');
      });
      this.metrics.pendingReferenceResolution('failed');
    } catch (error) {
      this.logger.error('pending_reference_failure_not_recorded', {
        transactionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function outcomeKey(outcome: ProcessingOutcome | 'skipped'): 'processed' | 'rejected' | 'rescheduled' | 'skipped' {
  switch (outcome) {
    case 'processed':
      return 'processed';
    case 'rejected':
      return 'rejected';
    case 'rescheduled':
      return 'rescheduled';
    default:
      return 'skipped';
  }
}
