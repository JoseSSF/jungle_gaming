import type { EventContext, IntegrationEvent } from '../../domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/events/wagering-events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { InsufficientFundsError } from '../../domain/shared/domain-error';
import { FailureCode } from '../../domain/wagering/failure-code';
import {
  INTERNAL_PROVIDER_ID,
  type WagerTransaction,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type { TransactionalRepositories } from '../ports/repositories';
import type { IdGenerator } from '../ports/runtime';
import type { ReferenceRetryPolicy } from './reference-retry-policy';

export interface ProcessingContext {
  now: Date;
  correlationId: string;
  causationId?: string;
}

export type ProcessingOutcome = 'processed' | 'rejected' | 'pending-reference' | 'rescheduled';

/**
 * Applies a wager transaction to a wallet. Shared by the synchronous path (HTTP/SQS)
 * and the PENDING_REFERENCE worker, so both follow exactly the same rules.
 *
 * Preconditions (guaranteed by callers): running inside a UnitOfWork and the wallet was
 * loaded with `lockById` (row lock held until commit).
 *
 * Writes happen in FK order: transaction → ledger entry → wallet → outbox.
 */
export class WagerTransactionProcessor {
  constructor(
    private readonly ids: IdGenerator,
    private readonly referencePolicy: ReferenceRetryPolicy,
  ) {}

  async process(
    repos: TransactionalRepositories,
    wallet: Wallet,
    tx: WagerTransaction,
    persistence: 'insert' | 'update',
    ctx: ProcessingContext,
  ): Promise<ProcessingOutcome> {
    const versionBefore = wallet.version;
    const decision = await this.decide(repos, wallet, tx, ctx);

    if (persistence === 'insert') await repos.transactions.insert(tx);
    else await repos.transactions.update(tx);

    if (decision.entry) {
      await repos.ledger.append(decision.entry);
      await repos.wallets.saveBalance(wallet, versionBefore);
    }
    if (decision.outcome === 'processed' && tx.providerId !== INTERNAL_PROVIDER_ID) {
      // Transactions parked waiting for this one become due immediately.
      await repos.transactions.expediteDependents(tx.providerId, tx.externalTransactionId, ctx.now);
    }
    const events = decision.events(this.eventContext(ctx));
    if (events.length > 0) {
      await repos.outbox.enqueue(events.map((event) => OutboxMessage.enqueue(event)));
    }
    return decision.outcome;
  }

  private async decide(
    repos: TransactionalRepositories,
    wallet: Wallet,
    tx: WagerTransaction,
    ctx: ProcessingContext,
  ): Promise<Decision> {
    const { now } = ctx;

    if (wallet.playerId !== tx.playerId) {
      // Do not leak the balance of a wallet owned by another player.
      tx.reject(FailureCode.WalletPlayerMismatch, now);
      return rejected(tx);
    }
    if (wallet.currency !== tx.money.currency) {
      // No balance snapshot: it would be expressed in a currency other than the transaction's.
      tx.reject(FailureCode.CurrencyMismatch, now);
      return rejected(tx);
    }

    let reference: WagerTransaction | undefined;
    if (tx.referenceExternalTransactionId !== undefined) {
      const candidate =
        (await repos.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId)) ?? undefined;
      const alreadyReversed =
        tx.isReversal() && candidate?.status === WagerTransactionStatus.Processed
          ? await repos.transactions.hasProcessedReversal(candidate.id)
          : false;
      const evaluation = tx.evaluateReference(candidate, alreadyReversed);
      switch (evaluation.outcome) {
        case 'missing':
          return this.awaitReference(wallet, tx, now);
        case 'invalid':
          tx.reject(evaluation.code, now, wallet.balance);
          return rejected(tx);
        case 'resolved':
          reference = evaluation.reference;
          break;
        case 'not-required':
          break;
      }
    }

    if (!tx.affectsBalance()) {
      tx.markProcessed(reference?.id, now, wallet.balance);
      return { outcome: 'processed', events: (c) => [WagerTransactionProcessed.from(tx, c())] };
    }

    const direction = tx.ledgerDirectionFor(reference);
    const movement = { money: tx.money, transactionId: tx.id, ledgerEntryId: this.ids.next(), at: now };
    let entry: WalletLedgerEntry;
    try {
      entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        tx.reject(
          tx.isReversal() ? FailureCode.ReversalWouldOverdraw : FailureCode.InsufficientFunds,
          now,
          wallet.balance,
        );
        return rejected(tx);
      }
      throw error;
    }
    tx.markProcessed(reference?.id, now, wallet.balance);
    return {
      outcome: 'processed',
      entry,
      events: (c) => [WagerTransactionProcessed.from(tx, c()), WalletBalanceChanged.from(wallet, entry, c())],
    };
  }

  private awaitReference(wallet: Wallet, tx: WagerTransaction, now: Date): Decision {
    if (tx.status === WagerTransactionStatus.Pending) {
      tx.markPendingReference(now, this.referencePolicy.nextCheckAt(now, 0), wallet.balance);
      return { outcome: 'pending-reference', events: (c) => [WagerTransactionPendingReference.from(tx, c())] };
    }
    // Worker path: the transaction is already PENDING_REFERENCE.
    if (this.referencePolicy.isExhausted(tx, now)) {
      tx.reject(FailureCode.ReferenceNotFound, now, wallet.balance);
      return rejected(tx);
    }
    tx.scheduleReferenceRetry(now, this.referencePolicy.nextCheckAt(now, tx.referenceAttempts + 1));
    return { outcome: 'rescheduled', events: () => [] };
  }

  private eventContext(ctx: ProcessingContext): () => EventContext {
    return () => ({
      eventId: this.ids.next(),
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.now,
    });
  }
}

interface Decision {
  outcome: ProcessingOutcome;
  entry?: WalletLedgerEntry;
  events(context: () => EventContext): IntegrationEvent<unknown>[];
}

function rejected(tx: WagerTransaction): Decision {
  return { outcome: 'rejected', events: (c) => [WagerTransactionRejected.from(tx, c())] };
}
