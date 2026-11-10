import { MikroORM } from '@mikro-orm/postgresql';
import { Pool } from 'pg';
import { loadConfig } from '../../src/config/app-config';
import { buildOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { TEST_DATABASE_URL, testEnv } from './env';

let prepared: Promise<void> | undefined;
let pool: Pool | undefined;

/** Direct SQL access for assertions (never used by the code under test). */
export function db(): Pool {
  pool ??= new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
  return pool;
}

/**
 * Recreates the test schema once per test process and applies the real migrations.
 * Tests isolate themselves by using fresh wallets / ids, never by truncating (the ledger
 * is append-only and its TRUNCATE is blocked by a trigger).
 */
export function prepareDatabase(): Promise<void> {
  prepared ??= (async () => {
    await db().query('DROP SCHEMA IF EXISTS public CASCADE');
    await db().query('CREATE SCHEMA public');
    const orm = await MikroORM.init(buildOrmConfig(loadConfig(testEnv())));
    try {
      await orm.getMigrator().up();
    } finally {
      await orm.close(true);
    }
  })();
  return prepared;
}

export async function closeDatabase(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

export async function scalar<T = string>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await db().query(sql, params);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return (row ? Object.values(row)[0] : undefined) as T;
}
