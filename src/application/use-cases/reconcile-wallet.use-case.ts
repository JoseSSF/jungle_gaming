import { Money } from '../../domain/money/money';
import { NotFoundError } from '../errors';
import type { UnitOfWork } from '../ports/repositories';
import type { Clock, Logger, WageringMetrics } from '../ports/runtime';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
  walletVersion: number;
  checkedAt: Date;
}

/**
 * Compares the materialized balance with the balance rebuilt from the ledger, inside a
 * REPEATABLE READ read-only snapshot (no lock, consistent view of both tables).
 * Divergences are never fixed silently: they are logged, counted and reported.
 */
export class ReconcileWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly metrics: WageringMetrics,
    private readonly logger: Logger,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const report = await this.uow.run(
      async (repos) => {
        const wallet = await repos.wallets.findById(walletId);
        if (!wallet) throw new NotFoundError('WALLET_NOT_FOUND', `Wallet ${walletId} not found`);
        const summary = await repos.ledger.summarize(walletId, wallet.currency);
        const credits = Money.from({ amount: summary.totalCredits, currency: wallet.currency });
        const debits = Money.from({ amount: summary.totalDebits, currency: wallet.currency });
        const calculatedBalance = credits.subtract(debits);
        const difference = wallet.balance.subtract(calculatedBalance);
        return {
          walletId,
          storedBalance: wallet.balance,
          calculatedBalance,
          difference,
          consistent: difference.isZero(),
          checkedEntries: summary.entries,
          walletVersion: wallet.version,
          checkedAt: this.clock.now(),
        } satisfies ReconciliationReport;
      },
      { isolation: 'repeatable-read', readOnly: true },
    );

    this.metrics.reconciliation(report.consistent);
    if (report.consistent) {
      this.logger.info('wallet_reconciled', { walletId, checkedEntries: report.checkedEntries });
    } else {
      this.logger.error('wallet_reconciliation_divergence', {
        walletId,
        checkedEntries: report.checkedEntries,
        walletVersion: report.walletVersion,
      });
    }
    return report;
  }
}
