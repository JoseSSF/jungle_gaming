import type { ReconciliationReport } from '../../application/use-cases/reconcile-wallet.use-case';
import type { MoneyProps } from '../../domain/money/money';
import { FAILURE_CODE_ACTIONS, type FailureCode, type ProviderAction } from '../../domain/wagering/failure-code';
import { type WagerTransaction, WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';

export function presentWallet(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

export function presentLedgerEntry(entry: WalletLedgerEntry) {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    walletVersion: entry.walletVersion,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}

export function presentTransaction(tx: WagerTransaction) {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    balance: tx.balanceAfter?.toJSON() ?? null,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString() ?? null,
  };
}

export interface SubmitResponseBody {
  transactionId: string | null;
  status: WagerTransactionStatus;
  balance: MoneyProps | null;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
  providerAction?: ProviderAction;
  nextReferenceCheckAt?: string;
}

/**
 * Submit status mapping (same for first response and replays):
 *   PROCESSED          201 Created
 *   PENDING_REFERENCE  202 Accepted (processing deferred)
 *   REJECTED           422 Unprocessable Entity (business rule; failureCode)
 *   FAILED             500 (permanent failure, auditable; failureCode PROCESSING_FAILED)
 */
export function submitHttpStatus(status: WagerTransactionStatus): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return 201;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      return 500;
  }
}

export function presentSubmitResult(tx: WagerTransaction, replay: boolean): SubmitResponseBody {
  const body: SubmitResponseBody = {
    transactionId: tx.id,
    status: tx.status,
    balance: tx.balanceAfter?.toJSON() ?? null,
    idempotentReplay: replay,
  };
  if (tx.failureCode) {
    body.failureCode = tx.failureCode;
    body.providerAction = FAILURE_CODE_ACTIONS[tx.failureCode];
  }
  if (tx.status === WagerTransactionStatus.PendingReference && tx.nextReferenceCheckAt) {
    body.nextReferenceCheckAt = tx.nextReferenceCheckAt.toISOString();
  }
  return body;
}

export function presentReconciliation(report: ReconciliationReport) {
  return {
    walletId: report.walletId,
    storedBalance: report.storedBalance.toJSON(),
    calculatedBalance: report.calculatedBalance.toJSON(),
    difference: report.difference.toJSON(),
    consistent: report.consistent,
    checkedEntries: report.checkedEntries,
    walletVersion: report.walletVersion,
    checkedAt: report.checkedAt.toISOString(),
  };
}
