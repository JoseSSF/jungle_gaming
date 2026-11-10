import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { TransactionalRepositories, UnitOfWork, UnitOfWorkOptions } from '../../application/ports/repositories';
import { translateDatabaseError } from './database-errors';
import { MikroOrmRepositories } from './repositories';

/**
 * UnitOfWork backed by `EntityManager.transactional()`.
 *
 * Each call runs on a fresh fork (own identity map), in one PostgreSQL transaction
 * (READ COMMITTED by default; the wallet row lock provides the per-wallet serialization).
 * Driver errors are translated into application errors *after* rollback, including
 * errors raised at COMMIT by deferred constraint triggers.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  async run<T>(work: (repos: TransactionalRepositories) => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    const em = this.orm.em.fork({ clear: true });
    try {
      return await em.transactional(
        async (tem: EntityManager) => {
          if (options.lockTimeoutMs !== undefined && options.lockTimeoutMs > 0) {
            // SET LOCAL cannot be parameterized; the value is an integer from config.
            await tem.execute(`SET LOCAL lock_timeout = '${Math.floor(options.lockTimeoutMs)}ms'`);
          }
          return work(new MikroOrmRepositories(tem));
        },
        {
          isolationLevel:
            options.isolation === 'repeatable-read' ? IsolationLevel.REPEATABLE_READ : IsolationLevel.READ_COMMITTED,
          readOnly: options.readOnly ?? false,
        },
      );
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
}
