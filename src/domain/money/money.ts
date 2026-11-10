import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from '../shared/domain-error';

/**
 * Isolated Decimal constructor: global Decimal configuration changes made by any
 * other library can never affect monetary arithmetic.
 * Precision 40 is far above what numeric(20,2) can hold, so add/subtract are exact.
 */
const MoneyDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -40,
  toExpPos: 40,
});

export const MONEY_SCALE = 2;
/** Matches numeric(20,2): up to 18 integer digits. */
const MAX_INTEGER_DIGITS = 18;

/**
 * Strict decimal-string grammar for *input contracts*:
 * - no sign (negative values are rejected in contracts), no exponent, no spaces;
 * - no leading zeros (except a single `0` before the point);
 * - at most 2 fractional digits (more is rejected, never rounded).
 */
const AMOUNT_PATTERN = new RegExp(`^(0|[1-9]\\d{0,${MAX_INTEGER_DIGITS - 1}})(\\.\\d{1,${MONEY_SCALE}})?$`);
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** DTO used on every contract (HTTP, SQS, events). `amount` is a decimal string. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

/**
 * Immutable monetary value object.
 *
 * - Backed by an arbitrary precision decimal, never by `number`.
 * - Serialized with a fixed scale of 2 (`"25.00"`).
 * - Operations between different currencies raise `CurrencyMismatchError`.
 * - Internal arithmetic may yield negative values (e.g. a reconciliation difference),
 *   but `Money.from` (the contract entry point) only accepts non-negative amounts.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Parses a contract value. Rejects NaN/Infinity/exponent/empty/>2 decimals/negatives. */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('Money must be an object with amount and currency');
    }
    const { amount, currency } = props as { amount: unknown; currency: unknown };
    Money.assertCurrency(currency);
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('Money amount must be a decimal string (numbers are not accepted)');
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `Invalid money amount "${amount.slice(0, 32)}": expected a non-negative decimal string with at most ${MONEY_SCALE} decimal places`,
      );
    }
    return new Money(new MoneyDecimal(amount), currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(new MoneyDecimal(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    if (this.isZero()) return this;
    return Money.of(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.greaterThan(other.value);
  }

  /** Same currency and same value. Never throws. */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  /** Decimal string with fixed scale 2 (may be negative for internal values). */
  toDecimalString(): string {
    if (this.value.isZero()) return '0.00';
    return this.value.toFixed(MONEY_SCALE);
  }

  toJSON(): MoneyProps {
    return { amount: this.toDecimalString(), currency: this.currency };
  }

  toString(): string {
    return `${this.toDecimalString()} ${this.currency}`;
  }

  private static of(value: Decimal, currency: string): Money {
    if (value.decimalPlaces() > MONEY_SCALE) {
      // Unreachable with add/subtract of 2-decimal values; guards future operations.
      throw new InvalidMoneyError(`Money scale overflow: ${value.toString()}`);
    }
    return new Money(value, currency);
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('Currency must be an ISO-4217 code (3 uppercase letters)');
    }
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
