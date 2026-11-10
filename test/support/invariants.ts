import { expect } from 'bun:test';
import { db } from './database';

/**
 * Global financial invariants, checked at the end of every integration/concurrency file:
 *  1. wallet.balance == balance rebuilt from the ledger (Σ credits − Σ debits);
 *  2. wallet.version == last ledger wallet_version (or 1 when there is no entry);
 *  3. no negative balance anywhere;
 *  4. every PROCESSED balance-affecting transaction has exactly one ledger entry, and
 *     LOSS / REJECTED / PENDING_REFERENCE / FAILED transactions have none;
 *  5. a reference is reverted at most once.
 */
export async function assertGlobalInvariants(): Promise<void> {
  const mismatches = await db().query(`
    SELECT w.id, w.balance::text AS stored, w.version,
           COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(20,2)::text AS rebuilt,
           COALESCE(MAX(l.wallet_version), 1) AS last_version
      FROM wallets w
      LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
     GROUP BY w.id
    HAVING w.balance <> COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)
        OR w.version <> COALESCE(MAX(l.wallet_version), 1)
        OR w.balance < 0`);
  expect(mismatches.rows).toEqual([]);

  const ledgerShape = await db().query(`
    SELECT t.id, t.kind, t.status, COUNT(l.id)::int AS entries
      FROM wager_transactions t
      LEFT JOIN wallet_ledger_entries l ON l.transaction_id = t.id
     GROUP BY t.id
    HAVING COUNT(l.id) <> CASE WHEN t.status = 'PROCESSED' AND t.kind <> 'LOSS' THEN 1 ELSE 0 END`);
  expect(ledgerShape.rows).toEqual([]);

  const doubleReversals = await db().query(`
    SELECT reference_transaction_id, COUNT(*)::int AS reversals
      FROM wager_transactions
     WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'
     GROUP BY reference_transaction_id
    HAVING COUNT(*) > 1`);
  expect(doubleReversals.rows).toEqual([]);
}

export async function walletState(walletId: string): Promise<{ balance: string; version: number; entries: number; debits: number }> {
  const result = await db().query(
    `SELECT w.balance::text AS balance, w.version,
            (SELECT COUNT(*)::int FROM wallet_ledger_entries l WHERE l.wallet_id = w.id) AS entries,
            (SELECT COUNT(*)::int FROM wallet_ledger_entries l WHERE l.wallet_id = w.id AND l.direction = 'DEBIT') AS debits
       FROM wallets w WHERE w.id = $1`,
    [walletId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`wallet ${walletId} not found`);
  return row as { balance: string; version: number; entries: number; debits: number };
}
