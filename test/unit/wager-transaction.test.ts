import { describe, expect, test } from 'bun:test';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '../../src/domain/shared/domain-error';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wagering/wager-transaction';
import { LedgerDirection } from '../../src/domain/wallet/wallet-ledger-entry';
import { brl, T0, usd, wager, wagerProps } from '../support/builders';

const processed = (tx: WagerTransaction): WagerTransaction => {
  tx.markProcessed(tx.referenceExternalTransactionId ? 'ref-id' : undefined, T0, brl('100.00'));
  return tx;
};

describe('WagerTransaction.create', () => {
  test('is born PENDING', () => {
    expect(wager().status).toBe(WagerTransactionStatus.Pending);
  });

  test('OPENING cannot be submitted', () => {
    expect(() => wager({ kind: WagerTransactionKind.Opening })).toThrow(InvalidWagerTransactionError);
  });

  test.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])('%s requires a reference', (kind) => {
    expect(() => wager({ kind })).toThrow(InvalidWagerTransactionError);
    expect(wager({ kind, referenceExternalTransactionId: 'bet-1' }).requiresReference()).toBe(true);
  });

  test('BET cannot reference another transaction; nothing can reference itself', () => {
    expect(() => wager({ kind: WagerTransactionKind.Bet, referenceExternalTransactionId: 'x' })).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() =>
      wager({ kind: WagerTransactionKind.Win, externalTransactionId: 'same', referenceExternalTransactionId: 'same' }),
    ).toThrow(InvalidWagerTransactionError);
  });

  test('zero amount is only valid for LOSS', () => {
    expect(wager({ kind: WagerTransactionKind.Loss, money: brl('0.00') }).affectsBalance()).toBe(false);
    expect(() => wager({ kind: WagerTransactionKind.Bet, money: brl('0.00') })).toThrow(InvalidWagerTransactionError);
    expect(() => wager({ kind: WagerTransactionKind.Win, money: brl('0.00') })).toThrow(InvalidWagerTransactionError);
  });
});

describe('WagerTransaction transitions', () => {
  test('PENDING → PROCESSED records reference, time and balance snapshot', () => {
    const tx = wager();
    tx.markProcessed(undefined, T0, brl('90.00'));
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.processedAt).toEqual(T0);
    expect(tx.balanceAfter?.toJSON().amount).toBe('90.00');
    expect(tx.isTerminal()).toBe(true);
  });

  test('terminal states reject every transition (programming error)', () => {
    const terminals = [
      processed(wager()),
      (() => {
        const tx = wager();
        tx.reject(FailureCode.InsufficientFunds, T0);
        return tx;
      })(),
      (() => {
        const tx = wager();
        tx.fail(FailureCode.ProcessingFailed, T0);
        return tx;
      })(),
    ];
    for (const tx of terminals) {
      expect(() => tx.markProcessed(undefined, T0, brl('1.00'))).toThrow(InvalidTransactionStateError);
      expect(() => tx.reject(FailureCode.InsufficientFunds, T0)).toThrow(InvalidTransactionStateError);
      expect(() => tx.fail(FailureCode.ProcessingFailed, T0)).toThrow(InvalidTransactionStateError);
      expect(() => tx.markPendingReference(T0, T0, undefined)).toThrow(InvalidTransactionStateError);
    }
  });

  test('PENDING_REFERENCE can be rescheduled, then processed or rejected', () => {
    const tx = wager({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'bet-1' });
    tx.markPendingReference(T0, new Date(T0.getTime() + 1000), brl('100.00'));
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.isReferenceCheckDue(T0)).toBe(false);
    expect(tx.isReferenceCheckDue(new Date(T0.getTime() + 1000))).toBe(true);
    tx.scheduleReferenceRetry(T0, new Date(T0.getTime() + 2000));
    expect(tx.referenceAttempts).toBe(1);
    tx.reject(FailureCode.ReferenceNotFound, T0, brl('100.00'));
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.nextReferenceCheckAt).toBeUndefined();
  });

  test('a transaction with a reference cannot be processed without resolving it', () => {
    const tx = wager({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'bet-1' });
    expect(() => tx.markProcessed(undefined, T0, brl('1.00'))).toThrow();
  });

  test('PROCESSING_FAILED is reserved for FAILED', () => {
    expect(() => wager().reject(FailureCode.ProcessingFailed, T0)).toThrow();
  });
});

describe('Business rules per kind', () => {
  const bet = processed(wager({ kind: WagerTransactionKind.Bet, externalTransactionId: 'bet-1' }));
  const win = processed(wager({ kind: WagerTransactionKind.Win, externalTransactionId: 'win-1' }));
  const refund = processed(
    wager({ kind: WagerTransactionKind.Refund, externalTransactionId: 'refund-1', referenceExternalTransactionId: 'bet-1' }),
  );

  test('ledger direction: BET debit, WIN/REFUND credit, ROLLBACK inverts its reference', () => {
    expect(wager({ kind: WagerTransactionKind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(wager({ kind: WagerTransactionKind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    const rollback = wager({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'x' });
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
  });

  test('LOSS does not affect the balance and has no ledger direction', () => {
    const loss = wager({ kind: WagerTransactionKind.Loss });
    expect(loss.affectsBalance()).toBe(false);
    expect(() => loss.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  test('REFUND only references BET', () => {
    const tx = wager({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'win-1' });
    expect(tx.evaluateReference(win, false)).toEqual({ outcome: 'invalid', code: FailureCode.ReferenceKindNotAllowed });
    const ok = wager({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'bet-1' });
    expect(ok.evaluateReference(bet, false).outcome).toBe('resolved');
  });

  test('ROLLBACK references BET, WIN or REFUND', () => {
    for (const reference of [bet, win, refund]) {
      const tx = wager({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: reference.externalTransactionId });
      expect(tx.evaluateReference(reference, false).outcome).toBe('resolved');
    }
  });

  test('WIN/LOSS may reference a BET of the same round', () => {
    const tx = wager({ kind: WagerTransactionKind.Win, referenceExternalTransactionId: 'bet-1' });
    expect(tx.evaluateReference(bet, false).outcome).toBe('resolved');
    expect(tx.evaluateReference(win, false)).toEqual({ outcome: 'invalid', code: FailureCode.ReferenceKindNotAllowed });
  });

  test('missing or not-yet-applied reference → wait (PENDING_REFERENCE)', () => {
    const tx = wager({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'bet-x' });
    expect(tx.evaluateReference(undefined, false)).toEqual({ outcome: 'missing' });
    const pendingBet = wager({ kind: WagerTransactionKind.Bet });
    expect(tx.evaluateReference(pendingBet, false)).toEqual({ outcome: 'missing' });
  });

  test('rejected reference cannot be reverted', () => {
    const rejectedBet = wager({ kind: WagerTransactionKind.Bet });
    rejectedBet.reject(FailureCode.InsufficientFunds, T0);
    const tx = wager({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: rejectedBet.externalTransactionId });
    expect(tx.evaluateReference(rejectedBet, false)).toEqual({ outcome: 'invalid', code: FailureCode.ReferenceNotProcessed });
  });

  test('reference must belong to the same player, wallet, currency and round', () => {
    const cases = [
      { playerId: 'other-player' },
      { walletId: 'other-wallet' },
      { roundId: 'other-round' },
      { money: usd('10.00') },
    ];
    for (const override of cases) {
      const reference = processed(wager({ kind: WagerTransactionKind.Bet, ...override }));
      const tx = wager({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: reference.externalTransactionId,
      });
      expect(tx.evaluateReference(reference, false)).toEqual({ outcome: 'invalid', code: FailureCode.ReferenceMismatch });
    }
  });

  test('reversal amount must equal the reference amount (no partial reversal)', () => {
    const tx = wager({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'bet-1', money: brl('9.99') });
    expect(tx.evaluateReference(bet, false)).toEqual({ outcome: 'invalid', code: FailureCode.ReferenceAmountMismatch });
  });

  test('a reference cannot be reverted twice', () => {
    const tx = wager({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'bet-1' });
    expect(tx.evaluateReference(bet, true)).toEqual({ outcome: 'invalid', code: FailureCode.ReferenceAlreadyReversed });
  });

  test('matchesPayload compares the stored hash', () => {
    const tx = WagerTransaction.create(wagerProps({ payloadHash: 'b'.repeat(64) }));
    expect(tx.matchesPayload('b'.repeat(64))).toBe(true);
    expect(tx.matchesPayload('c'.repeat(64))).toBe(false);
  });
});
