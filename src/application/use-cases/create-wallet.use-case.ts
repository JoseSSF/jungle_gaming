import { z } from 'zod';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../../domain/events/wagering-events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/money/money';
import { DomainError } from '../../domain/shared/domain-error';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { zodIssues } from '../commands/submit-wager-transaction.command';
import { InvalidCommandError } from '../errors';
import { canonicalJson, sha256Hex } from '../idempotency/payload-hash';
import type { UnitOfWork } from '../ports/repositories';
import type { Clock, IdGenerator, Logger, WageringMetrics } from '../ports/runtime';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: Money;
}

const createWalletSchema = z
  .object({
    playerId: z
      .string({ required_error: 'is required', invalid_type_error: 'must be a string' })
      .min(1, 'must not be empty')
      .max(128, 'must have at most 128 characters')
      .regex(/^[A-Za-z0-9._:@\-]+$/, 'contains invalid characters'),
    initialBalance: z
      .object({ amount: z.string(), currency: z.string() }, { required_error: 'is required' })
      .strict(),
  })
  .strict();

export function parseCreateWalletCommand(payload: unknown): CreateWalletCommand {
  const parsed = createWalletSchema.safeParse(payload);
  if (!parsed.success) {
    throw new InvalidCommandError('INVALID_PAYLOAD', 'Request payload is invalid', zodIssues(parsed.error));
  }
  try {
    return { playerId: parsed.data.playerId, initialBalance: Money.from(parsed.data.initialBalance) };
  } catch (error) {
    if (error instanceof DomainError) {
      throw new InvalidCommandError('INVALID_MONEY', error.message, [{ path: 'initialBalance', message: error.message }]);
    }
    throw error;
  }
}

/**
 * Opens a wallet. A positive initial balance creates an internal OPENING transaction and
 * its CREDIT ledger entry in the same SQL transaction (wallet version 1 = ledger entry #1).
 */
export class CreateWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly metrics: WageringMetrics,
    private readonly logger: Logger,
  ) {}

  async execute(command: CreateWalletCommand, context: { correlationId: string }): Promise<Wallet> {
    const wallet = await this.uow.run(async (repos) => {
      const now = this.clock.now();
      const walletId = this.ids.next();
      const opening = command.initialBalance.isPositive()
        ? WagerTransaction.createOpening({
            id: this.ids.next(),
            walletId,
            playerId: command.playerId,
            money: command.initialBalance,
            payloadHash: sha256Hex(
              canonicalJson({ walletId, playerId: command.playerId, initialBalance: command.initialBalance.toJSON() }),
            ),
            correlationId: context.correlationId,
            createdAt: now,
          })
        : undefined;

      const { wallet: opened, openingEntry } = Wallet.open({
        id: walletId,
        playerId: command.playerId,
        initialBalance: command.initialBalance,
        at: now,
        opening: opening ? { transactionId: opening.id, ledgerEntryId: this.ids.next() } : undefined,
      });

      await repos.wallets.insert(opened);
      if (opening && openingEntry) {
        opening.markProcessed(undefined, now, opened.balance);
        await repos.transactions.insert(opening);
        await repos.ledger.append(openingEntry);
        const ctx = () => ({ eventId: this.ids.next(), correlationId: context.correlationId, occurredAt: now });
        await repos.outbox.enqueue([
          OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, ctx())),
          OutboxMessage.enqueue(WalletBalanceChanged.from(opened, openingEntry, ctx())),
        ]);
      }
      return opened;
    });
    if (command.initialBalance.isPositive()) {
      this.metrics.transactionCompleted('OPENING', 'PROCESSED', 'internal');
    }
    this.logger.info('wallet_created', { walletId: wallet.id });
    return wallet;
  }
}
