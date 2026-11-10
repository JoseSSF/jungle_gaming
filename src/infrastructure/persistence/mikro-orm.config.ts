import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import type { AppConfig } from '../../config/app-config';
import { ALL_ENTITY_SCHEMAS } from './entities';
import { Migration20261109120000_core_schema } from './migrations/Migration20261109120000_core_schema';
import { Migration20261109120100_integrity_triggers } from './migrations/Migration20261109120100_integrity_triggers';

/** Ordered list of versioned, reversible migrations (explicit: no filesystem discovery). */
export const MIGRATIONS = [
  { name: 'Migration20261109120000_core_schema', class: Migration20261109120000_core_schema },
  { name: 'Migration20261109120100_integrity_triggers', class: Migration20261109120100_integrity_triggers },
];

export function buildOrmConfig(config: AppConfig, overrides: Partial<Options> = {}): Options {
  return defineConfig({
    clientUrl: config.database.url,
    entities: ALL_ENTITY_SCHEMAS,
    discovery: { warnWhenNoEntities: true, requireEntitiesArray: true },
    // Forks only: no accidental shared identity map between concurrent requests.
    allowGlobalContext: false,
    // The pool connects lazily: the process starts (and reports not-ready) while PostgreSQL
    // is temporarily unavailable instead of crash-looping. The schema comes from migrations.
    ensureDatabase: false,
    forceUtcTimezone: true,
    pool: { min: 0, max: config.database.poolMax, idleTimeoutMillis: 30_000 },
    driverOptions: {
      connection: {
        statement_timeout: config.database.statementTimeoutMs,
        connectionTimeoutMillis: config.database.connectTimeoutMs,
        application_name: `wagering-${config.instanceId}`.slice(0, 63),
      },
    },
    extensions: [Migrator],
    migrations: {
      tableName: 'mikro_orm_migrations',
      migrationsList: MIGRATIONS,
      transactional: true,
      allOrNothing: true,
      // Never use session_replication_role=replica: it would silently disable our triggers.
      disableForeignKeys: false,
      snapshot: false,
      emit: 'ts',
    },
    debug: false,
    ...overrides,
  });
}
