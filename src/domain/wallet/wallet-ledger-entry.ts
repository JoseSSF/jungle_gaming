import { Money } from '../money/money';
import { InvariantViolationError } from '../shared/domain-error';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  /** Wallet version *after* this entry is applied: a gapless per-wallet sequence. */
  walletVersion: number;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Immutable, append-only ledger line.
 *
 * There are no mutable fields and no transition methods: immutability is structural
 * (readonly fields + frozen instance), and is also enforced by database triggers.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly walletVersion: number,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** Validates the entry arithmetic: `balanceBefore ± money === balanceAfter`. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.build(props);
    if (!entry.money.isPositive()) {
      throw new InvariantViolationError('Ledger entry amount must be positive');
    }
    if (entry.balanceBefore.isNegative() || entry.balanceAfter.isNegative()) {
      throw new InvariantViolationError('Ledger entry balances can never be negative');
    }
    if (!Number.isInteger(entry.walletVersion) || entry.walletVersion < 1) {
      throw new InvariantViolationError('Ledger entry wallet version must be a positive integer');
    }
    if (!entry.isBalanced()) {
      throw new InvariantViolationError(
        `Unbalanced ledger entry: ${entry.balanceBefore.toString()} ${entry.direction} ${entry.money.toString()} != ${entry.balanceAfter.toString()}`,
      );
    }
    return entry;
  }

  /** Reconstruction from persistence — trusts already persisted (and DB-checked) state. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return WalletLedgerEntry.build(state);
  }

  /** `balanceBefore ± money === balanceAfter` (throws on currency mismatch). */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Signed effect of the entry on the balance (credit positive, debit negative). */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }

  private static build(props: CreateLedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.walletVersion,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );
  }
}
