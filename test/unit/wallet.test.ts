import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money/money';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvariantViolationError,
} from '../../src/domain/shared/domain-error';
import { Wallet } from '../../src/domain/wallet/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger-entry';
import { brl, openWallet, T0, usd } from '../support/builders';

const movement = (amount: string, n = 1) => ({
  money: brl(amount),
  transactionId: `tx-${n}`,
  ledgerEntryId: `entry-${n}`,
  at: new Date(T0.getTime() + n * 1000),
});

describe('Wallet.open', () => {
  test('positive initial balance → version 1 and an OPENING credit entry (#1)', () => {
    const { wallet, openingEntry } = openWallet('1000.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(openingEntry).toBeDefined();
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.walletVersion).toBe(1);
    expect(openingEntry?.balanceBefore.toJSON().amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.toJSON().amount).toBe('1000.00');
  });

  test('zero initial balance → version 1 and no ledger entry', () => {
    const { wallet, openingEntry } = Wallet.open({ id: 'w', playerId: 'p', initialBalance: Money.zero('BRL'), at: T0 });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.isZero()).toBe(true);
    expect(openingEntry).toBeUndefined();
  });

  test('positive initial balance without an OPENING transaction is rejected', () => {
    expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00'), at: T0 })).toThrow(InvariantViolationError);
  });
});

describe('Wallet movements', () => {
  test('debit decreases balance, increments version once and returns the matching entry', () => {
    const { wallet } = openWallet('100.00');
    const entry = wallet.debit(movement('25.00'));
    expect(wallet.balance.toJSON().amount).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.walletVersion).toBe(2);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('75.00');
    expect(entry.isBalanced()).toBe(true);
  });

  test('credit increases balance', () => {
    const { wallet } = openWallet('100.00');
    const entry = wallet.credit(movement('0.01'));
    expect(wallet.balance.toJSON().amount).toBe('100.01');
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test('balance can reach exactly zero but never below', () => {
    const { wallet } = openWallet('80.00');
    wallet.debit(movement('80.00'));
    expect(wallet.balance.isZero()).toBe(true);
    expect(() => wallet.debit(movement('0.01', 2))).toThrow(InsufficientFundsError);
  });

  test('insufficient funds leaves state untouched (no partial mutation)', () => {
    const { wallet } = openWallet('100.00');
    expect(() => wallet.debit(movement('100.01'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('operation currency must equal wallet currency', () => {
    const { wallet } = openWallet('100.00');
    expect(() => wallet.debit({ ...movement('1.00'), money: usd('1.00') })).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit({ ...movement('1.00'), money: usd('1.00') })).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('zero movements are refused (version only changes when the balance changes)', () => {
    const { wallet } = openWallet('100.00');
    expect(() => wallet.credit(movement('0.00'))).toThrow(InvariantViolationError);
    expect(wallet.version).toBe(1);
  });

  test('successive entries form a gapless chain that rebuilds the balance', () => {
    const { wallet, openingEntry } = openWallet('100.00');
    const entries = [openingEntry as WalletLedgerEntry];
    entries.push(wallet.debit(movement('30.00', 1)));
    entries.push(wallet.credit(movement('12.34', 2)));
    entries.push(wallet.debit(movement('82.34', 3)));
    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i]?.walletVersion).toBe((entries[i - 1]?.walletVersion ?? 0) + 1);
      expect(entries[i]?.balanceBefore.equals(entries[i - 1]?.balanceAfter as Money)).toBe(true);
    }
    const rebuilt = entries.reduce((sum, entry) => sum.add(entry.signedAmount()), Money.zero('BRL'));
    expect(rebuilt.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.toJSON().amount).toBe('0.00');
    expect(wallet.version).toBe(4);
  });

  test('rehydrate restores persisted state without revalidation', () => {
    const wallet = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balance: brl('5.00'),
      version: 7,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.toJSON().amount).toBe('5.00');
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e',
    walletId: 'w',
    transactionId: 't',
    walletVersion: 2,
    createdAt: T0,
  };

  test('create validates the arithmetic', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('10.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('91.00'),
      }),
    ).toThrow(InvariantViolationError);
  });

  test('rejects non-positive amounts and negative balances', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('0.00'),
        balanceBefore: brl('1.00'),
        balanceAfter: brl('1.00'),
      }),
    ).toThrow(InvariantViolationError);
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('2.00'),
        balanceBefore: brl('1.00'),
        balanceAfter: brl('1.00').subtract(brl('2.00')),
      }),
    ).toThrow(InvariantViolationError);
  });

  test('is structurally immutable', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('1.00'),
      balanceBefore: brl('1.00'),
      balanceAfter: brl('2.00'),
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { walletVersion: number }).walletVersion = 99;
    }).toThrow();
  });
});
