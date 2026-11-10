import { describe, expect, test } from 'bun:test';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../../src/domain/events/wagering-events';
import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { InvalidTransactionStateError } from '../../src/domain/shared/domain-error';
import { LedgerDirection } from '../../src/domain/wallet/wallet-ledger-entry';
import { brl, openWallet, T0, wager } from '../support/builders';

const ctx = { eventId: '0192f298-345e-7e38-af88-e43f851a819d', correlationId: 'corr', causationId: 'msg-1', occurredAt: T0 };

describe('Integration events', () => {
  test('eventType and version live in the type; data carries MoneyProps strings', () => {
    const { wallet } = openWallet('100.00');
    const entry = wallet.debit({ money: brl('25.00'), transactionId: 'tx-1', ledgerEntryId: 'e-1', at: T0 });
    const event = WalletBalanceChanged.from(wallet, entry, ctx);
    expect(event.eventType).toBe('WalletBalanceChanged');
    expect(event.version).toBe(1);
    expect(event.toJSON()).toEqual({
      eventId: ctx.eventId,
      eventType: 'WalletBalanceChanged',
      aggregateId: wallet.id,
      correlationId: 'corr',
      causationId: 'msg-1',
      occurredAt: T0.toISOString(),
      version: 1,
      data: {
        walletId: wallet.id,
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  test('WagerTransactionProcessed requires a processed transaction', () => {
    const tx = wager();
    expect(() => WagerTransactionProcessed.from(tx, ctx)).toThrow();
    tx.markProcessed(undefined, T0, brl('90.00'));
    const json = WagerTransactionProcessed.from(tx, ctx).toJSON();
    expect(json.data.balanceAfter).toEqual({ amount: '90.00', currency: 'BRL' });
    expect(typeof json.data.money.amount).toBe('string');
  });
});

describe('OutboxMessage', () => {
  const makeMessage = () => {
    const tx = wager();
    tx.markProcessed(undefined, T0, brl('90.00'));
    return OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, ctx));
  };

  test('enqueue stores the serialized, frozen envelope; id === eventId', () => {
    const message = makeMessage();
    expect(message.id).toBe(ctx.eventId);
    expect(message.payload.eventId).toBe(ctx.eventId);
    expect(Object.isFrozen(message.payload)).toBe(true);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(T0)).toBe(true);
  });

  test('scheduleRetry increments attempts with capped exponential backoff', () => {
    const message = makeMessage();
    const policy = { baseDelayMs: 1000, maxDelayMs: 5000 };
    const delays: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      message.scheduleRetry(T0, 'boom', policy);
      delays.push((message.nextAttemptAt?.getTime() ?? 0) - T0.getTime());
    }
    expect(delays).toEqual([1000, 2000, 4000, 5000, 5000]);
    expect(message.attempts).toBe(5);
    expect(message.isDue(T0)).toBe(false);
  });

  test('cannot be published twice', () => {
    const message = makeMessage();
    message.markPublished(T0);
    expect(message.isPending()).toBe(false);
    expect(() => message.markPublished(T0)).toThrow(InvalidTransactionStateError);
    expect(() => message.scheduleRetry(T0)).toThrow(InvalidTransactionStateError);
  });
});

describe('InboxMessage', () => {
  test('is processed once', () => {
    const inbox = InboxMessage.receive({ messageId: 'm', consumerName: 'c', payloadHash: 'h', receivedAt: T0 });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(T0);
    expect(inbox.isProcessed()).toBe(true);
    expect(() => inbox.markProcessed(T0)).toThrow(InvalidTransactionStateError);
  });
});
