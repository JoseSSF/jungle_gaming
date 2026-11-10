import { EntitySchema } from '@mikro-orm/core';

/*
 * Persistence records (MikroORM EntitySchema, no decorators).
 *
 * The domain model never depends on the ORM: repositories map records <-> aggregates and
 * rebuild aggregates with their `rehydrate` factories. Monetary columns are numeric(20,2)
 * mapped as *strings* (MikroORM DecimalType default), converted to `Money` in mappers —
 * a JS `number` never touches a monetary value.
 *
 * Column names follow the UnderscoreNamingStrategy (playerId -> player_id). The DDL itself
 * lives in hand-written, reversible migrations (constraints/triggers are part of the design).
 */

const decimal = { type: 'decimal', precision: 20, scale: 2, runtimeType: 'string' } as const;
const timestamptz = { type: 'datetime', columnType: 'timestamptz' } as const;

export interface WalletRecord {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'string', length: 128 },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: { ...decimal },
    version: { type: 'integer' },
    createdAt: { ...timestamptz },
    updatedAt: { ...timestamptz },
  },
});

export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  balanceAfter: string | null;
  referenceAttempts: number;
  nextReferenceCheckAt: Date | null;
  correlationId: string;
  createdAt: Date;
  updatedAt: Date;
  processedAt: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', length: 64 },
    externalTransactionId: { type: 'string', length: 128 },
    idempotencyKey: { type: 'string', length: 256 },
    payloadHash: { type: 'string', columnType: 'char(64)' },
    walletId: { type: 'uuid' },
    playerId: { type: 'string', length: 128 },
    roundId: { type: 'string', length: 128 },
    gameId: { type: 'string', length: 128 },
    kind: { type: 'string', length: 16 },
    amount: { ...decimal },
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: { type: 'string', length: 128, nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'string', length: 24 },
    failureCode: { type: 'string', length: 64, nullable: true },
    balanceAfter: { ...decimal, nullable: true },
    referenceAttempts: { type: 'integer' },
    nextReferenceCheckAt: { ...timestamptz, nullable: true },
    correlationId: { type: 'string', length: 128 },
    createdAt: { ...timestamptz },
    updatedAt: { ...timestamptz },
    processedAt: { ...timestamptz, nullable: true },
  },
});

export interface LedgerEntryRecord {
  id: string;
  walletId: string;
  transactionId: string;
  walletVersion: number;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    walletVersion: { type: 'integer' },
    direction: { type: 'string', length: 6 },
    amount: { ...decimal },
    currency: { type: 'string', columnType: 'char(3)' },
    balanceBefore: { ...decimal },
    balanceAfter: { ...decimal },
    createdAt: { ...timestamptz },
  },
});

export interface InboxRecord {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

export const InboxSchema = new EntitySchema<InboxRecord>({
  name: 'InboxRecord',
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', length: 128, primary: true },
    messageId: { type: 'string', length: 256, primary: true },
    payloadHash: { type: 'string', columnType: 'char(64)' },
    receivedAt: { ...timestamptz },
    processedAt: { ...timestamptz, nullable: true },
  },
});

export interface OutboxRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
  lastError: string | null;
}

export const OutboxSchema = new EntitySchema<OutboxRecord>({
  name: 'OutboxRecord',
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'string', length: 128 },
    eventType: { type: 'string', length: 128 },
    eventVersion: { type: 'integer' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { ...timestamptz },
    attempts: { type: 'integer' },
    nextAttemptAt: { ...timestamptz, nullable: true },
    publishedAt: { ...timestamptz, nullable: true },
    lastError: { type: 'string', length: 1024, nullable: true },
  },
});

export const ALL_ENTITY_SCHEMAS = [WalletSchema, WagerTransactionSchema, LedgerEntrySchema, InboxSchema, OutboxSchema];
