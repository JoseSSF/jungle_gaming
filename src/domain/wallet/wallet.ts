import { Money } from '../money/money';
import { CurrencyMismatchError, InsufficientFundsError, InvariantViolationError } from '../shared/domain-error';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
  /** Required when `initialBalance` is positive: identifies the internal OPENING transaction. */
  opening?: { transactionId: string; ledgerEntryId: string };
}

export interface OpenedWallet {
  wallet: Wallet;
  /** CREDIT entry for the OPENING transaction (absent when the initial balance is zero). */
  openingEntry?: WalletLedgerEntry;
}

export interface BalanceMovement {
  money: Money;
  transactionId: string;
  ledgerEntryId: string;
  at: Date;
}

const INITIAL_VERSION = 1;

/**
 * Wallet aggregate root.
 *
 * Every balance change goes through `debit`/`credit`, which return the matching
 * ledger entry: the materialized balance and the ledger are produced by the same
 * code path and can never drift apart in the domain. `version` starts at 1 and is
 * incremented exactly once per balance change (it is also the ledger sequence).
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenedWallet {
    const { initialBalance } = props;
    if (initialBalance.isNegative()) {
      throw new InvariantViolationError('Initial balance cannot be negative');
    }
    if (props.playerId.trim().length === 0) {
      throw new InvariantViolationError('playerId is required');
    }
    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      initialBalance,
      INITIAL_VERSION,
      props.at,
      props.at,
    );
    if (initialBalance.isZero()) {
      return { wallet };
    }
    if (!props.opening) {
      throw new InvariantViolationError('A positive initial balance requires an OPENING transaction');
    }
    // The opening credit is part of the creation: it is ledger entry #1 and version 1.
    const openingEntry = WalletLedgerEntry.create({
      id: props.opening.ledgerEntryId,
      walletId: wallet.id,
      transactionId: props.opening.transactionId,
      walletVersion: INITIAL_VERSION,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      createdAt: props.at,
    });
    return { wallet, openingEntry };
  }

  /** Reconstruction from persistence — does not revalidate transitions. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /** Debits the wallet. Throws `InsufficientFundsError` if the balance would go negative. */
  debit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertMovement(movement.money);
    if (!this.canDebit(movement.money)) {
      throw new InsufficientFundsError(this.id);
    }
    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertMovement(movement.money);
    return this.apply(LedgerDirection.Credit, movement);
  }

  private apply(direction: LedgerDirection, movement: BalanceMovement): WalletLedgerEntry {
    const before = this._balance;
    const after =
      direction === LedgerDirection.Credit ? before.add(movement.money) : before.subtract(movement.money);
    const entry = WalletLedgerEntry.create({
      id: movement.ledgerEntryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      walletVersion: this._version + 1,
      direction,
      money: movement.money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: movement.at,
    });
    // Only mutate after the entry has been validated.
    this._balance = after;
    this._version += 1;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertMovement(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvariantViolationError('Balance movements must be strictly positive');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
