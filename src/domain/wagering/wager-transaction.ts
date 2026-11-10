import { Money } from '../money/money';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  InvariantViolationError,
} from '../shared/domain-error';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';
import { FailureCode } from './failure-code';

export enum WagerTransactionKind {
  /** Internal: opening credit of a wallet. Never accepted from API/queue. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  /** Accepted, not yet applied (in-memory only: never committed in this design). */
  Pending = 'PENDING',
  /** Waiting for the referenced transaction to arrive. */
  PendingReference = 'PENDING_REFERENCE',
  /** Applied (terminal). */
  Processed = 'PROCESSED',
  /** Business rule violation (terminal). */
  Rejected = 'REJECTED',
  /** Permanent infrastructure error (terminal, auditable). */
  Failed = 'FAILED',
}

export const EXTERNAL_KINDS: readonly WagerTransactionKind[] = Object.freeze([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** Which kinds each kind may reference (business rule table, section 7). */
const ALLOWED_REFERENCE_KINDS: Readonly<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Opening]: [],
  [WagerTransactionKind.Bet]: [],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

export const INTERNAL_PROVIDER_ID = 'internal';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  correlationId: string;
  createdAt: Date;
}

export type WagerTransactionShape = Pick<
  CreateWagerTransactionProps,
  'kind' | 'money' | 'externalTransactionId' | 'referenceExternalTransactionId'
>;

export interface CreateOpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  payloadHash: string;
  correlationId: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  balanceAfter?: Money;
  referenceAttempts: number;
  nextReferenceCheckAt?: Date;
  updatedAt: Date;
}

/** Result of checking a referenced transaction against the business rules. */
export type ReferenceEvaluation =
  | { readonly outcome: 'not-required' }
  | { readonly outcome: 'missing' }
  | { readonly outcome: 'resolved'; readonly reference: WagerTransaction }
  | { readonly outcome: 'invalid'; readonly code: FailureCode };

/**
 * A wager operation received from a provider (or the internal OPENING credit).
 *
 * Valid transitions:
 *
 *   PENDING ─┬─> PROCESSED          (terminal)
 *            ├─> REJECTED           (terminal)
 *            ├─> FAILED             (terminal)
 *            └─> PENDING_REFERENCE ─┬─> PENDING_REFERENCE (reschedule, attempts++)
 *                                   ├─> PROCESSED
 *                                   ├─> REJECTED
 *                                   └─> FAILED
 *
 * Any transition attempted from a terminal state raises InvalidTransactionStateError.
 * The same rules are enforced by a database trigger.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** Id on the provider side — not the internal id. */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly correlationId: string,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _updatedAt: Date,
    private _referenceAttempts: number,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _balanceAfter?: Money,
    private _nextReferenceCheckAt?: Date,
  ) {}

  /** Born PENDING. Validates the reference requirements per kind. OPENING is not accepted here. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    WagerTransaction.assertValidShape(props);
    return WagerTransaction.newPending(props);
  }

  /** Internal OPENING credit created together with the wallet. */
  static createOpening(props: CreateOpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvariantViolationError('OPENING requires a positive amount');
    }
    return WagerTransaction.newPending({
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: `opening:${props.walletId}`,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'internal',
      kind: WagerTransactionKind.Opening,
      money: props.money,
      correlationId: props.correlationId,
      createdAt: props.createdAt,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.correlationId,
      state.createdAt,
      state.status,
      state.updatedAt,
      state.referenceAttempts,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.balanceAfter,
      state.nextReferenceCheckAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  /** Wallet balance observed when the transaction reached its current status (replay snapshot). */
  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceCheckAt(): Date | undefined {
    return this._nextReferenceCheckAt;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ---------------------------------------------------------------- transitions

  markProcessed(referenceTransactionId: string | undefined, at: Date, balanceAfter: Money): void {
    this.assertNotTerminal('markProcessed');
    if (this.referenceExternalTransactionId !== undefined && referenceTransactionId === undefined) {
      throw new InvariantViolationError('A transaction with a reference can only be processed once resolved');
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._balanceAfter = balanceAfter;
    this._nextReferenceCheckAt = undefined;
    this._updatedAt = at;
  }

  markPendingReference(at: Date, nextCheckAt: Date, balanceAfter: Money | undefined): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(`markPendingReference is only valid from PENDING (was ${this._status})`);
    }
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvariantViolationError('Only transactions with a reference can wait for it');
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._nextReferenceCheckAt = nextCheckAt;
    this._balanceAfter = balanceAfter;
    this._updatedAt = at;
  }

  /** Another unsuccessful attempt to resolve the reference: attempts++ and reschedule. */
  scheduleReferenceRetry(at: Date, nextCheckAt: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(`scheduleReferenceRetry requires PENDING_REFERENCE (was ${this._status})`);
    }
    this._referenceAttempts += 1;
    this._nextReferenceCheckAt = nextCheckAt;
    this._updatedAt = at;
  }

  reject(code: FailureCode, at: Date, balanceAfter?: Money): void {
    this.assertNotTerminal('reject');
    if (code === FailureCode.ProcessingFailed) {
      throw new InvariantViolationError('PROCESSING_FAILED is reserved for FAILED transactions');
    }
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._balanceAfter = balanceAfter;
    this._nextReferenceCheckAt = undefined;
    this._updatedAt = at;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextReferenceCheckAt = undefined;
    this._updatedAt = at;
  }

  // ---------------------------------------------------------------- domain queries

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /** false for LOSS: it records the round result without moving money. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** true for REFUND and ROLLBACK. */
  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  isReferenceCheckDue(now: Date): boolean {
    return (
      this._status === WagerTransactionStatus.PendingReference &&
      this._nextReferenceCheckAt !== undefined &&
      this._nextReferenceCheckAt.getTime() <= now.getTime()
    );
  }

  /** Direction of the ledger entry this transaction produces. ROLLBACK inverts its reference. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvariantViolationError('ROLLBACK direction depends on its reference');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError('LOSS does not affect the balance and has no ledger direction');
    }
  }

  /**
   * Validates the referenced transaction (resolved by providerId + referenceExternalTransactionId).
   * `alreadyReversed` tells whether a PROCESSED REFUND/ROLLBACK already targets the reference.
   */
  evaluateReference(reference: WagerTransaction | undefined, alreadyReversed: boolean): ReferenceEvaluation {
    if (this.referenceExternalTransactionId === undefined) {
      return { outcome: 'not-required' };
    }
    if (!reference) {
      return { outcome: 'missing' };
    }
    if (
      reference.status === WagerTransactionStatus.Pending ||
      reference.status === WagerTransactionStatus.PendingReference
    ) {
      // The reference exists but is not applied yet: wait like a missing one.
      return { outcome: 'missing' };
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return { outcome: 'invalid', code: FailureCode.ReferenceNotProcessed };
    }
    if (
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.money.currency !== this.money.currency ||
      reference.roundId !== this.roundId
    ) {
      return { outcome: 'invalid', code: FailureCode.ReferenceMismatch };
    }
    if (!ALLOWED_REFERENCE_KINDS[this.kind].includes(reference.kind)) {
      return { outcome: 'invalid', code: FailureCode.ReferenceKindNotAllowed };
    }
    if (this.isReversal()) {
      if (!reference.money.equals(this.money)) {
        return { outcome: 'invalid', code: FailureCode.ReferenceAmountMismatch };
      }
      if (alreadyReversed) {
        return { outcome: 'invalid', code: FailureCode.ReferenceAlreadyReversed };
      }
    }
    return { outcome: 'resolved', reference };
  }

  // ---------------------------------------------------------------- internals

  private assertNotTerminal(operation: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Cannot ${operation}: transaction ${this.id} is already ${this._status} (terminal)`,
      );
    }
  }

  private static newPending(props: CreateWagerTransactionProps): WagerTransaction {
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.correlationId,
      props.createdAt,
      WagerTransactionStatus.Pending,
      props.createdAt,
      0,
    );
  }

  /**
   * Shape rules that do not depend on persisted state. Public so that transports can
   * validate a payload *before* opening a database transaction.
   */
  static assertValidShape(props: WagerTransactionShape): void {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError('KIND_NOT_ALLOWED', 'OPENING is internal and cannot be submitted');
    }
    const kind = props.kind;
    const reference = props.referenceExternalTransactionId;
    if (props.money.isNegative()) {
      throw new InvalidWagerTransactionError('INVALID_AMOUNT', 'Amount cannot be negative');
    }
    if (kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new InvalidWagerTransactionError('INVALID_AMOUNT', `${kind} amount must be greater than zero`);
    }
    const requiresReference = kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
    if (requiresReference && (reference === undefined || reference.length === 0)) {
      throw new InvalidWagerTransactionError('REFERENCE_REQUIRED', `${kind} requires referenceExternalTransactionId`);
    }
    if (kind === WagerTransactionKind.Bet && reference !== undefined) {
      throw new InvalidWagerTransactionError('REFERENCE_NOT_ALLOWED', 'BET cannot reference another transaction');
    }
    if (reference !== undefined && reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError('SELF_REFERENCE', 'A transaction cannot reference itself');
    }
  }
}
