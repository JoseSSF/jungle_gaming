/**
 * Base class for every error raised by the domain layer.
 *
 * Domain errors are *expected* outcomes of applying business rules (or programming
 * errors detected by an aggregate). They never carry infrastructure details.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Raised when a monetary value or currency fails validation. */
export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';

  constructor(message: string) {
    super(message);
  }
}

/** Raised when two `Money` values with different currencies are combined. */
export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

/** Raised by `Wallet.debit` when the balance does not cover the amount. */
export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(walletId: string) {
    super(`Wallet ${walletId} has insufficient funds`);
  }
}

/**
 * Raised when a wager transaction is created with an invalid shape
 * (e.g. REFUND without reference, OPENING submitted externally).
 */
export class InvalidWagerTransactionError extends DomainError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Raised when a state transition is attempted from a terminal state.
 * This is a programming error, never a business path.
 */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(message: string) {
    super(message);
  }
}

/** Raised when an aggregate invariant would be broken (programming error). */
export class InvariantViolationError extends DomainError {
  readonly code = 'INVARIANT_VIOLATION';

  constructor(message: string) {
    super(message);
  }
}
