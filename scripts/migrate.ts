import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../src/config/app-config';
import { buildOrmConfig } from '../src/infrastructure/persistence/mikro-orm.config';

/**
 * Versioned, reversible migrations.
 *   bun run migration:up        apply pending migrations
 *   bun run migration:down      revert the last migration
 *   bun run scripts/migrate.ts down:all   revert everything
 *   bun run migration:status    list executed / pending
 */
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const orm = await MikroORM.init(buildOrmConfig(loadConfig()));
  try {
    const migrator = orm.getMigrator();
    switch (command) {
      case 'up': {
        const applied = await migrator.up();
        console.log(JSON.stringify({ msg: 'migrations_applied', migrations: applied.map((m) => m.name) }));
        break;
      }
      case 'down': {
        const reverted = await migrator.down();
        console.log(JSON.stringify({ msg: 'migration_reverted', migrations: reverted.map((m) => m.name) }));
        break;
      }
      case 'down:all': {
        const reverted = await migrator.down({ to: 0 });
        console.log(JSON.stringify({ msg: 'migrations_reverted', migrations: reverted.map((m) => m.name) }));
        break;
      }
      case 'status': {
        const executed = await migrator.getExecutedMigrations();
        const pending = await migrator.getPendingMigrations();
        console.log(
          JSON.stringify(
            { executed: executed.map((m) => m.name), pending: pending.map((m) => m.name) },
            null,
            2,
          ),
        );
        break;
      }
      default:
        throw new Error(`Unknown command "${command}" (use up | down | down:all | status)`);
    }
  } finally {
    await orm.close(true);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
