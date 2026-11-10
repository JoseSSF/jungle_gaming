import { Money } from '../../src/domain/money/money';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
} from '../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../src/domain/wallet/wallet';

let sequence = 0;
export const nextId = (prefix = 'id'): string => `${prefix}-${++sequence}`;

export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

export const T0 = new Date('2026-07-29T15:00:00.000Z');

export function openWallet(amount = '100.00', overrides: { id?: string; playerId?: string; currency?: string } = {}) {
  const currency = overrides.currency ?? 'BRL';
  return Wallet.open({
    id: overrides.id ?? 'wallet-1',
    playerId: overrides.playerId ?? 'player-1',
    initialBalance: Money.from({ amount, currency }),
    at: T0,
    opening: { transactionId: 'opening-tx', ledgerEntryId: 'opening-entry' },
  });
}

export function wagerProps(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  const externalTransactionId = overrides.externalTransactionId ?? nextId('ext');
  return {
    id: nextId('tx'),
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl('10.00'),
    correlationId: 'corr-1',
    createdAt: T0,
    ...overrides,
  };
}

export function wager(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  return WagerTransaction.create(wagerProps(overrides));
}
