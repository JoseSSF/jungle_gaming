import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import type { PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { loadConfig } from '../../src/config/app-config';
import { buildOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { db, prepareDatabase, scalar } from '../support/database';
import { testEnv } from '../support/env';
import { assertGlobalInvariants } from '../support/invariants';

/*
 * The schema is the last line of defense: every guarantee is exercised here with raw SQL,
 * bypassing the application entirely.
 */

const HASH = 'a'.repeat(64);

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function sqlState(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    return String((error as { code?: string }).code ?? (error as Error).message);
  }
  throw new Error('expected the database to reject the statement');
}

interface Seed {
  walletId: string;
  openingId: string;
}

/** A consistent wallet: wallet(100.00, v1) + OPENING transaction + CREDIT entry #1. */
async function seedWallet(balance = '100.00'): Promise<Seed> {
  const walletId = uuidv7();
  const openingId = uuidv7();
  await inTransaction(async (client) => {
    await client.query(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES ($1, $2, 'BRL', $3, 1, now(), now())`,
      [walletId, `player-${walletId}`, balance],
    );
    await client.query(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
         player_id, round_id, game_id, kind, amount, currency, status, balance_after, correlation_id, created_at, updated_at, processed_at)
       VALUES ($1, 'internal', $2, $2, $3, $4, $5, 'opening', 'internal', 'OPENING', $6, 'BRL', 'PROCESSED', $6, 'c', now(), now(), now())`,
      [openingId, `opening:${walletId}`, HASH, walletId, `player-${walletId}`, balance],
    );
    await client.query(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, wallet_version, direction, amount, currency,
         balance_before, balance_after, created_at)
       VALUES ($1, $2, $3, 1, 'CREDIT', $4, 'BRL', 0, $4, now())`,
      [uuidv7(), walletId, openingId, balance],
    );
  });
  return { walletId, openingId };
}

async function insertTransaction(
  client: PoolClient | ReturnType<typeof db>,
  seed: Seed,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = (overrides.id as string) ?? uuidv7();
  const values = {
    external: `ext-${id}`,
    key: `key-${id}`,
    kind: 'BET',
    amount: '10.00',
    status: 'PROCESSED',
    balanceAfter: '90.00',
    referenceExternal: null,
    referenceId: null,
    failureCode: null,
    processedAt: new Date(),
    nextCheck: null,
    ...overrides,
  };
  await client.query(
    `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
       player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
       status, failure_code, balance_after, next_reference_check_at, correlation_id, created_at, updated_at, processed_at)
     VALUES ($1, 'provider-a', $2, $3, $4, $5, $6, 'round-1', 'game', $7, $8, 'BRL', $9, $10, $11, $12, $13, $14, 'c', now(), now(), $15)`,
    [
      id,
      values.external,
      values.key,
      HASH,
      seed.walletId,
      `player-${seed.walletId}`,
      values.kind,
      values.amount,
      values.referenceExternal,
      values.referenceId,
      values.status,
      values.failureCode,
      values.balanceAfter,
      values.nextCheck,
      values.status === 'PROCESSED' ? values.processedAt : null,
    ],
  );
  return id;
}

/** BET of 10.00 applied consistently (transaction + entry #2 + wallet v2). */
async function applyBet(seed: Seed): Promise<string> {
  return inTransaction(async (client) => {
    const id = await insertTransaction(client, seed);
    await client.query(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after, created_at)
       VALUES ($1, $2, $3, 2, 'DEBIT', 10.00, 'BRL', 100.00, 90.00, now())`,
      [uuidv7(), seed.walletId, id],
    );
    await client.query(`UPDATE wallets SET balance = 90.00, version = 2, updated_at = now() WHERE id = $1`, [seed.walletId]);
    return id;
  });
}

beforeAll(async () => {
  await prepareDatabase();
});

afterAll(async () => {
  await assertGlobalInvariants();
});

describe('migrations', () => {
  test('are versioned and reversible (down → up)', async () => {
    const orm = await MikroORM.init(buildOrmConfig(loadConfig(testEnv())));
    try {
      const migrator = orm.getMigrator();
      expect((await migrator.getExecutedMigrations()).map((m) => m.name)).toEqual([
        'Migration20261109120000_core_schema',
        'Migration20261109120100_integrity_triggers',
      ]);
      await migrator.down({ to: 0 });
      expect(await scalar<number>(`SELECT COUNT(*)::int FROM information_schema.tables WHERE table_name = 'wallets'`)).toBe(0);
      await migrator.up();
      expect(await scalar<number>(`SELECT COUNT(*)::int FROM information_schema.tables WHERE table_name = 'wallets'`)).toBe(1);
      expect((await migrator.getPendingMigrations()).length).toBe(0);
    } finally {
      await orm.close(true);
    }
  });
});

describe('wallets', () => {
  test('balance can never be negative', async () => {
    const seed = await seedWallet();
    expect(await sqlState(() => db().query('UPDATE wallets SET balance = -0.01 WHERE id = $1', [seed.walletId]))).toBe('23514');
  });

  test('one wallet per playerId + currency', async () => {
    const seed = await seedWallet('0.00');
    const playerId = `player-${seed.walletId}`;
    expect(
      await sqlState(() =>
        db().query(
          `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at) VALUES ($1, $2, 'BRL', 0, 1, now(), now())`,
          [uuidv7(), playerId],
        ),
      ),
    ).toBe('23505');
  });

  test('a balance change without its ledger entry is refused at COMMIT', async () => {
    const seed = await seedWallet();
    expect(
      await sqlState(() =>
        inTransaction((client) =>
          client.query('UPDATE wallets SET balance = 50.00, version = 2 WHERE id = $1', [seed.walletId]),
        ),
      ),
    ).toBe('23000');
    expect(await scalar(`SELECT balance::text FROM wallets WHERE id = $1`, [seed.walletId])).toBe('100.00');
  });

  test('a ledger entry without the matching wallet update is refused at COMMIT', async () => {
    const seed = await seedWallet();
    expect(
      await sqlState(() =>
        inTransaction(async (client) => {
          const id = await insertTransaction(client, seed);
          await client.query(
            `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after, created_at)
             VALUES ($1, $2, $3, 2, 'DEBIT', 10.00, 'BRL', 100.00, 90.00, now())`,
            [uuidv7(), seed.walletId, id],
          );
        }),
      ),
    ).toBe('23000');
  });

  test('a consistent movement commits', async () => {
    const seed = await seedWallet();
    await applyBet(seed);
    expect(await scalar(`SELECT balance::text FROM wallets WHERE id = $1`, [seed.walletId])).toBe('90.00');
  });
});

describe('ledger', () => {
  test('is append-only: UPDATE, DELETE and TRUNCATE are rejected', async () => {
    const seed = await seedWallet();
    expect(await sqlState(() => db().query('UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = $1', [seed.walletId]))).toBe('23000');
    expect(await sqlState(() => db().query('DELETE FROM wallet_ledger_entries WHERE wallet_id = $1', [seed.walletId]))).toBe('23000');
    expect(await sqlState(() => db().query('TRUNCATE wallet_ledger_entries CASCADE'))).toBe('23000');
  });

  test('arithmetic is checked: balance_before ± amount = balance_after', async () => {
    const seed = await seedWallet();
    expect(
      await sqlState(() =>
        inTransaction(async (client) => {
          const id = await insertTransaction(client, seed);
          await client.query(
            `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after, created_at)
             VALUES ($1, $2, $3, 2, 'DEBIT', 10.00, 'BRL', 100.00, 95.00, now())`,
            [uuidv7(), seed.walletId, id],
          );
        }),
      ),
    ).toBe('23514');
  });

  test('chain must be continuous (no gap, no fork)', async () => {
    const seed = await seedWallet();
    expect(
      await sqlState(() =>
        inTransaction(async (client) => {
          const id = await insertTransaction(client, seed);
          await client.query(
            `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after, created_at)
             VALUES ($1, $2, $3, 3, 'DEBIT', 10.00, 'BRL', 100.00, 90.00, now())`,
            [uuidv7(), seed.walletId, id],
          );
        }),
      ),
    ).toBe('23000');
  });

  test('at most one entry per transaction and wallet', async () => {
    const seed = await seedWallet();
    const betId = await applyBet(seed);
    expect(
      await sqlState(() =>
        db().query(
          `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after, created_at)
           VALUES ($1, $2, $3, 3, 'DEBIT', 10.00, 'BRL', 90.00, 80.00, now())`,
          [uuidv7(), seed.walletId, betId],
        ),
      ),
    ).toBe('23505');
  });

  test('ledger currency must be the wallet currency', async () => {
    const seed = await seedWallet();
    expect(
      await sqlState(() =>
        inTransaction(async (client) => {
          const id = await insertTransaction(client, seed);
          await client.query(
            `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after, created_at)
             VALUES ($1, $2, $3, 2, 'DEBIT', 10.00, 'USD', 100.00, 90.00, now())`,
            [uuidv7(), seed.walletId, id],
          );
        }),
      ),
    ).toBe('23503');
  });
});

describe('wager transactions', () => {
  test('idempotency key and external id are unique per provider', async () => {
    const seed = await seedWallet();
    await insertTransaction(db(), seed, { key: 'dup-key', status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balanceAfter: null });
    expect(
      await sqlState(() =>
        insertTransaction(db(), seed, { key: 'dup-key', status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balanceAfter: null }),
      ),
    ).toBe('23505');
    await insertTransaction(db(), seed, { external: 'dup-ext', status: 'REJECTED', failureCode: 'X', balanceAfter: null });
    expect(
      await sqlState(() => insertTransaction(db(), seed, { external: 'dup-ext', status: 'REJECTED', failureCode: 'X', balanceAfter: null })),
    ).toBe('23505');
  });

  test('terminal statuses are final and business columns immutable', async () => {
    const seed = await seedWallet();
    const id = await insertTransaction(db(), seed, { status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balanceAfter: null });
    expect(await sqlState(() => db().query(`UPDATE wager_transactions SET status = 'PROCESSED' WHERE id = $1`, [id]))).toBe('23000');
    expect(await sqlState(() => db().query('DELETE FROM wager_transactions WHERE id = $1', [id]))).toBe('23000');
    const pending = await insertTransaction(db(), seed, {
      kind: 'REFUND',
      status: 'PENDING_REFERENCE',
      referenceExternal: 'missing',
      balanceAfter: null,
      nextCheck: new Date(),
    });
    expect(await sqlState(() => db().query(`UPDATE wager_transactions SET amount = 99 WHERE id = $1`, [pending]))).toBe('23000');
  });

  test('shape checks: REFUND needs a reference, BET cannot have one, PROCESSED needs a balance snapshot', async () => {
    const seed = await seedWallet();
    expect(await sqlState(() => insertTransaction(db(), seed, { kind: 'REFUND', status: 'REJECTED', failureCode: 'X', balanceAfter: null }))).toBe('23514');
    expect(await sqlState(() => insertTransaction(db(), seed, { kind: 'BET', referenceExternal: 'x', status: 'REJECTED', failureCode: 'X' }))).toBe('23514');
    expect(await sqlState(() => insertTransaction(db(), seed, { status: 'PROCESSED', balanceAfter: null }))).toBe('23514');
    expect(await sqlState(() => insertTransaction(db(), seed, { status: 'REJECTED', failureCode: null }))).toBe('23514');
    expect(await sqlState(() => insertTransaction(db(), seed, { amount: '0.00', status: 'REJECTED', failureCode: 'X' }))).toBe('23514');
  });

  test('a reference can be reverted at most once (partial unique index)', async () => {
    const seed = await seedWallet();
    const betId = await applyBet(seed);
    const reversal = (client: PoolClient | ReturnType<typeof db>, kind: string) =>
      insertTransaction(client, seed, {
        kind,
        status: 'PROCESSED',
        referenceExternal: `ext-${betId}`,
        referenceId: betId,
        balanceAfter: '100.00',
      });
    // First reversal, applied consistently (transaction + CREDIT entry #3 + wallet v3).
    await inTransaction(async (client) => {
      const refundId = await reversal(client, 'REFUND');
      await client.query(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after, created_at)
         VALUES ($1, $2, $3, 3, 'CREDIT', 10.00, 'BRL', 90.00, 100.00, now())`,
        [uuidv7(), seed.walletId, refundId],
      );
      await client.query('UPDATE wallets SET balance = 100.00, version = 3, updated_at = now() WHERE id = $1', [seed.walletId]);
    });
    // Any second PROCESSED reversal of the same reference is refused by the index.
    expect(await sqlState(() => reversal(db(), 'ROLLBACK'))).toBe('23505');
  });
});

describe('outbox', () => {
  test('event content is immutable and publication is final', async () => {
    const id = uuidv7();
    await db().query(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, event_version, payload, occurred_at, attempts)
       VALUES ($1, 'agg', 'Test', 1, $2, now(), 0)`,
      [id, JSON.stringify({ eventId: id })],
    );
    expect(await sqlState(() => db().query(`UPDATE outbox_messages SET payload = '{"eventId":"x"}' WHERE id = $1`, [id]))).toBe('23000');
    await db().query('UPDATE outbox_messages SET published_at = now() WHERE id = $1', [id]);
    expect(await sqlState(() => db().query('UPDATE outbox_messages SET published_at = NULL WHERE id = $1', [id]))).toBe('23000');
  });

  test('payload.eventId must equal the row id', async () => {
    expect(
      await sqlState(() =>
        db().query(
          `INSERT INTO outbox_messages (id, aggregate_id, event_type, event_version, payload, occurred_at, attempts)
           VALUES ($1, 'agg', 'Test', 1, '{"eventId":"other"}', now(), 0)`,
          [uuidv7()],
        ),
      ),
    ).toBe('23514');
  });
});
