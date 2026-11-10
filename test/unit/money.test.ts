import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money/money';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/shared/domain-error';
import { brl, usd } from '../support/builders';

describe('Money — parsing and validation', () => {
  test.each([
    ['25.00', '25.00'],
    ['25.5', '25.50'],
    ['25', '25.00'],
    ['0', '0.00'],
    ['0.01', '0.01'],
    ['999999999999999999.99', '999999999999999999.99'],
  ])('accepts %p and serializes with fixed scale 2 as %p', (input, expected) => {
    expect(Money.from({ amount: input, currency: 'BRL' }).toJSON()).toEqual({ amount: expected, currency: 'BRL' });
  });

  test.each([
    ['NaN'],
    ['Infinity'],
    ['-Infinity'],
    ['1e3'],
    ['1E-2'],
    [''],
    [' '],
    ['10.005'],
    ['0.001'],
    ['-1.00'],
    ['+1.00'],
    ['01.00'],
    ['1.'],
    ['.50'],
    [' 1.00'],
    ['1,00'],
    ['0x10'],
    ['1000000000000000000.00'],
  ])('rejects invalid amount %p', (input) => {
    expect(() => Money.from({ amount: input, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('rejects numbers (precision would already be lost)', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: 0.1 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test.each([['brl'], ['BR'], ['BRLX'], [''], ['12A']])('rejects invalid currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  test('never rounds: more than two decimals is an error, not a rounding', () => {
    expect(() => brl('0.125')).toThrow(InvalidMoneyError);
    expect(() => brl('0.135')).toThrow(InvalidMoneyError);
  });
});

describe('Money — arithmetic', () => {
  test('is exact where binary floating point is not', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
    expect(brl('1.00').subtract(brl('0.90')).toJSON().amount).toBe('0.10');
    let total = Money.zero('BRL');
    for (let i = 0; i < 1000; i += 1) total = total.add(brl('0.01'));
    expect(total.toJSON().amount).toBe('10.00');
  });

  test('handles the full numeric(20,2) range exactly', () => {
    const big = brl('999999999999999999.98');
    expect(big.add(brl('0.01')).toJSON().amount).toBe('999999999999999999.99');
  });

  test('is immutable: operations return new instances', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.toJSON().amount).toBe('10.00');
    expect(b.toJSON().amount).toBe('15.00');
    expect(Object.isFrozen(a)).toBe(true);
  });

  test('subtract can yield negative internal values; negate flips sign', () => {
    const negative = brl('10.00').subtract(brl('25.50'));
    expect(negative.isNegative()).toBe(true);
    expect(negative.toJSON().amount).toBe('-15.50');
    expect(negative.negate().toJSON().amount).toBe('15.50');
    expect(Money.zero('BRL').negate().toJSON().amount).toBe('0.00');
  });

  test('comparisons', () => {
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('9.99').isLessThan(brl('10.00'))).toBe(true);
    expect(brl('10.00').isLessThan(brl('10.00'))).toBe(false);
    expect(brl('10.0').equals(brl('10.00'))).toBe(true);
    expect(brl('10.00').equals(usd('10.00'))).toBe(false);
  });

  test('operations between different currencies raise a domain error', () => {
    expect(() => brl('1.00').add(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd('1.00'))).toThrow(CurrencyMismatchError);
  });

  test('serialization', () => {
    expect(brl('25.5').toString()).toBe('25.50 BRL');
    expect(JSON.stringify({ money: brl('25.5') })).toBe('{"money":{"amount":"25.50","currency":"BRL"}}');
  });
});
