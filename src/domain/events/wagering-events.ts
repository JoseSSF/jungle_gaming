import type { MoneyProps } from '../money/money';
import type { FailureCode } from '../wagering/failure-code';
import type { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../wagering/wager-transaction';
import type { Wallet } from '../wallet/wallet';
import type { LedgerDirection, WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import { type EventContext, IntegrationEvent } from './integration-event';

interface TransactionIdentity {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

function identityOf(tx: WagerTransaction): TransactionIdentity {
  const identity: TransactionIdentity = {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
  if (tx.referenceExternalTransactionId !== undefined) {
    identity.referenceExternalTransactionId = tx.referenceExternalTransactionId;
  }
  return identity;
}

// ------------------------------------------------------------------ WagerTransactionProcessed

export interface WagerTransactionProcessedData extends TransactionIdentity {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  /** Balance observed right after the transaction was applied (LOSS included). */
  balanceAfter: MoneyProps;
  processedAt: string;
}

/** Any applied transaction, including LOSS (which does not move money). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (!tx.balanceAfter || !tx.processedAt) {
      throw new Error(`Transaction ${tx.id} is not processed`);
    }
    const data: WagerTransactionProcessedData = {
      ...identityOf(tx),
      status: tx.status,
      balanceAfter: tx.balanceAfter.toJSON(),
      processedAt: tx.processedAt.toISOString(),
    };
    if (tx.referenceTransactionId !== undefined) data.referenceTransactionId = tx.referenceTransactionId;
    return new WagerTransactionProcessed({ ...ctx, aggregateId: tx.id, data });
  }
}

// ------------------------------------------------------------------ WagerTransactionRejected

export interface WagerTransactionRejectedData {
  /** Absent when the transaction could not be persisted (e.g. WALLET_NOT_FOUND). */
  transactionId?: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!tx.failureCode) throw new Error(`Transaction ${tx.id} has no failure code`);
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.id,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        failureCode: tx.failureCode,
      },
    });
  }

  /** Rejection of a request that never became a transaction row (unknown wallet). */
  static unpersisted(data: Omit<WagerTransactionRejectedData, 'transactionId'>, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({ ...ctx, aggregateId: data.walletId, data });
  }
}

// ------------------------------------------------------------------ WagerTransactionFailed

export interface WagerTransactionFailedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: WagerTransactionKind;
  failureCode: FailureCode;
}

/** Permanent (non-business) failure recorded for audit. */
export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  readonly eventType = 'WagerTransactionFailed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionFailed {
    if (!tx.failureCode) throw new Error(`Transaction ${tx.id} has no failure code`);
    return new WagerTransactionFailed({
      ...ctx,
      aggregateId: tx.id,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        kind: tx.kind,
        failureCode: tx.failureCode,
      },
    });
  }
}

// ------------------------------------------------------------------ WagerTransactionPendingReference

export interface WagerTransactionPendingReferenceData extends TransactionIdentity {
  referenceExternalTransactionId: string;
  nextCheckAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (tx.referenceExternalTransactionId === undefined || tx.nextReferenceCheckAt === undefined) {
      throw new Error(`Transaction ${tx.id} is not waiting for a reference`);
    }
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...identityOf(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        nextCheckAt: tx.nextReferenceCheckAt.toISOString(),
      },
    });
  }
}

// ------------------------------------------------------------------ WalletBalanceChanged

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  /** Monotonic per wallet: consumers use it to order / discard stale events. */
  walletVersion: number;
}

/** Emitted only when the balance actually changes. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) throw new Error('Ledger entry does not belong to wallet');
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}
