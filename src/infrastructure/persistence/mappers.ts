import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/money/money';
import type { FailureCode } from '../../domain/wagering/failure-code';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { type LedgerDirection, WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type {
  InboxRecord,
  LedgerEntryRecord,
  OutboxRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './entities';

const money = (amount: string, currency: string): Money => Money.from({ amount, currency });
const orUndefined = <T>(value: T | null): T | undefined => (value === null ? undefined : value);

export function walletToDomain(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: money(record.balance, record.currency),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function walletToRecord(wallet: Wallet): WalletRecord {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toDecimalString(),
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function transactionToDomain(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind as WagerTransactionKind,
    money: money(record.amount, record.currency),
    referenceExternalTransactionId: orUndefined(record.referenceExternalTransactionId),
    correlationId: record.correlationId,
    createdAt: record.createdAt,
    status: record.status as WagerTransactionStatus,
    referenceTransactionId: orUndefined(record.referenceTransactionId),
    failureCode: orUndefined(record.failureCode) as FailureCode | undefined,
    processedAt: orUndefined(record.processedAt),
    // Wallet balance snapshot, always in the transaction currency (see balanceSnapshot).
    balanceAfter: record.balanceAfter === null ? undefined : money(record.balanceAfter, record.currency),
    referenceAttempts: record.referenceAttempts,
    nextReferenceCheckAt: orUndefined(record.nextReferenceCheckAt),
    updatedAt: record.updatedAt,
  });
}

export function transactionToRecord(tx: WagerTransaction): WagerTransactionRecord {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    amount: tx.money.toDecimalString(),
    currency: tx.money.currency,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    balanceAfter: balanceSnapshot(tx),
    referenceAttempts: tx.referenceAttempts,
    nextReferenceCheckAt: tx.nextReferenceCheckAt ?? null,
    correlationId: tx.correlationId,
    createdAt: tx.createdAt,
    updatedAt: tx.updatedAt,
    processedAt: tx.processedAt ?? null,
  };
}

/** Mutable columns written on state transitions. */
export function transactionStateToRecord(tx: WagerTransaction): Partial<WagerTransactionRecord> {
  const record = transactionToRecord(tx);
  return {
    status: record.status,
    referenceTransactionId: record.referenceTransactionId,
    failureCode: record.failureCode,
    balanceAfter: record.balanceAfter,
    referenceAttempts: record.referenceAttempts,
    nextReferenceCheckAt: record.nextReferenceCheckAt,
    updatedAt: record.updatedAt,
    processedAt: record.processedAt,
  };
}

/**
 * The balance snapshot is only meaningful in the transaction currency. A CURRENCY_MISMATCH
 * rejection observed a balance in another currency: it is not persisted (NULL) so that a
 * row can never mix currencies.
 */
function balanceSnapshot(tx: WagerTransaction): string | null {
  const balance = tx.balanceAfter;
  if (!balance || balance.currency !== tx.money.currency) return null;
  return balance.toDecimalString();
}

export function ledgerEntryToDomain(record: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    walletVersion: record.walletVersion,
    direction: record.direction as LedgerDirection,
    money: money(record.amount, record.currency),
    balanceBefore: money(record.balanceBefore, record.currency),
    balanceAfter: money(record.balanceAfter, record.currency),
    createdAt: record.createdAt,
  });
}

export function ledgerEntryToRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    walletVersion: entry.walletVersion,
    direction: entry.direction,
    amount: entry.money.toDecimalString(),
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.toDecimalString(),
    balanceAfter: entry.balanceAfter.toDecimalString(),
    createdAt: entry.createdAt,
  };
}

export function inboxToDomain(record: InboxRecord): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: record.consumerName,
    messageId: record.messageId,
    payloadHash: record.payloadHash,
    receivedAt: record.receivedAt,
    processedAt: orUndefined(record.processedAt),
  });
}

export function outboxToDomain(record: OutboxRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: record.id,
    aggregateId: record.aggregateId,
    eventType: record.eventType,
    eventVersion: record.eventVersion,
    payload: record.payload,
    occurredAt: record.occurredAt,
    attempts: record.attempts,
    nextAttemptAt: orUndefined(record.nextAttemptAt),
    publishedAt: orUndefined(record.publishedAt),
    lastError: orUndefined(record.lastError),
  });
}

export function outboxToRecord(message: OutboxMessage): OutboxRecord {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    eventVersion: message.eventVersion,
    payload: message.payload as Record<string, unknown>,
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt ?? null,
    publishedAt: message.publishedAt ?? null,
    lastError: message.lastError ?? null,
  };
}
