/**
 * Stable, machine-readable failure codes carried by REJECTED / FAILED transactions.
 *
 * Every code is terminal for its idempotency key: re-sending the *same* request
 * returns the same rejection (replay). The `providerAction` tells the provider what
 * to do next — it is part of the public contract (see ARCHITECTURE.md §Failure codes).
 */
export enum FailureCode {
  /** BET larger than the available balance. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** REFUND/ROLLBACK whose application would make the balance negative. */
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  /** Operation currency differs from the wallet currency. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** walletId does not exist. */
  WalletNotFound = 'WALLET_NOT_FOUND',
  /** walletId exists but belongs to another playerId. */
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  /** Referenced transaction never arrived within the retry budget (attempts / TTL). */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referenced transaction exists but is REJECTED or FAILED. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Referenced transaction belongs to another player/wallet/currency/round. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** e.g. REFUND referencing a WIN, WIN referencing a LOSS. */
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  /** REFUND/ROLLBACK amount differs from the referenced amount (partial reversal unsupported). */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  /** Referenced transaction was already reverted. */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** Permanent infrastructure / invariant failure (status FAILED). */
  ProcessingFailed = 'PROCESSING_FAILED',
}

export type ProviderAction =
  /** Do not resend with the same key; the decision is final. */
  | 'GIVE_UP'
  /** Fix the payload and resend with a NEW idempotency key. */
  | 'FIX_AND_RESEND_NEW_KEY'
  /** Escalate to operations; the platform recorded an auditable failure. */
  | 'CONTACT_OPERATOR';

export const FAILURE_CODE_ACTIONS: Readonly<Record<FailureCode, ProviderAction>> = Object.freeze({
  [FailureCode.InsufficientFunds]: 'GIVE_UP',
  [FailureCode.ReversalWouldOverdraw]: 'CONTACT_OPERATOR',
  [FailureCode.CurrencyMismatch]: 'FIX_AND_RESEND_NEW_KEY',
  [FailureCode.WalletNotFound]: 'FIX_AND_RESEND_NEW_KEY',
  [FailureCode.WalletPlayerMismatch]: 'FIX_AND_RESEND_NEW_KEY',
  [FailureCode.ReferenceNotFound]: 'FIX_AND_RESEND_NEW_KEY',
  [FailureCode.ReferenceNotProcessed]: 'GIVE_UP',
  [FailureCode.ReferenceMismatch]: 'FIX_AND_RESEND_NEW_KEY',
  [FailureCode.ReferenceKindNotAllowed]: 'FIX_AND_RESEND_NEW_KEY',
  [FailureCode.ReferenceAmountMismatch]: 'FIX_AND_RESEND_NEW_KEY',
  [FailureCode.ReferenceAlreadyReversed]: 'GIVE_UP',
  [FailureCode.ProcessingFailed]: 'CONTACT_OPERATOR',
});

export function isFailureCode(value: string): value is FailureCode {
  return (Object.values(FailureCode) as string[]).includes(value);
}
