import { describe, expect, test } from 'bun:test';
import { parseSubmitWagerTransactionCommand } from '../../src/application/commands/submit-wager-transaction.command';
import { InvalidCommandError } from '../../src/application/errors';
import { canonicalJson, wagerPayloadHash } from '../../src/application/idempotency/payload-hash';
import { parseWagerMessage } from '../../src/infrastructure/messaging/wager-message';

const payload = () => ({
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
});

describe('canonical JSON', () => {
  test('sorts keys recursively and omits undefined', () => {
    expect(canonicalJson({ b: 1 === 1, a: { d: 'x', c: null }, z: undefined })).toBe('{"a":{"c":null,"d":"x"},"b":true}');
  });

  test('is independent of key insertion order', () => {
    const a = canonicalJson({ x: 'a', y: { p: 'q', r: 's' } });
    const b = canonicalJson({ y: { r: 's', p: 'q' }, x: 'a' });
    expect(a).toBe(b);
  });

  test('refuses numbers (money must travel as strings)', () => {
    expect(() => canonicalJson({ amount: 25 })).toThrow(TypeError);
  });
});

describe('payload hash', () => {
  test('same business payload → same hash regardless of key order and amount scale', () => {
    const one = parseSubmitWagerTransactionCommand(payload(), 'provider-a:transaction-123');
    const reordered = Object.fromEntries(Object.entries(payload()).reverse());
    const two = parseSubmitWagerTransactionCommand({ ...reordered, money: { currency: 'BRL', amount: '25.0' } }, 'other-key');
    expect(two.payloadHash).toBe(one.payloadHash);
  });

  test('idempotency key is not part of the hash; every business field is', () => {
    const base = parseSubmitWagerTransactionCommand(payload(), 'k1').payloadHash;
    expect(parseSubmitWagerTransactionCommand(payload(), 'k2').payloadHash).toBe(base);
    const variants: Array<Record<string, unknown>> = [
      { money: { amount: '25.01', currency: 'BRL' } },
      { money: { amount: '25.00', currency: 'USD' } },
      { roundId: 'round-988' },
      { gameId: 'other-game' },
      { kind: 'WIN' },
      { playerId: 'someone-else' },
    ];
    for (const variant of variants) {
      expect(parseSubmitWagerTransactionCommand({ ...payload(), ...variant }, 'k1').payloadHash).not.toBe(base);
    }
  });

  test('hash is SHA-256 hex of the canonical subset', () => {
    const hash = wagerPayloadHash({ ...payload(), money: { amount: '25.00', currency: 'BRL' } });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('command validation (shared by HTTP and SQS)', () => {
  const invalid = (body: unknown, ...args: unknown[]) => {
    const key = args.length > 0 ? args[0] : 'k';
    try {
      parseSubmitWagerTransactionCommand(body, key);
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidCommandError);
      return error as InvalidCommandError;
    }
    throw new Error('expected InvalidCommandError');
  };

  test('Idempotency-Key is mandatory', () => {
    expect(invalid(payload(), undefined).issues.some((issue) => issue.path === 'idempotencyKey')).toBe(true);
    invalid(payload(), '');
    invalid(payload(), 'has space');
  });

  test('OPENING is internal', () => {
    expect(invalid({ ...payload(), kind: 'OPENING' }).issues[0]?.message).toContain('internal');
  });

  test('amount must be a decimal string', () => {
    invalid({ ...payload(), money: { amount: 25, currency: 'BRL' } });
    expect(invalid({ ...payload(), money: { amount: '1e2', currency: 'BRL' } }).code).toBe('INVALID_MONEY');
    expect(invalid({ ...payload(), money: { amount: '-5.00', currency: 'BRL' } }).code).toBe('INVALID_MONEY');
  });

  test('REFUND/ROLLBACK require a reference; unknown fields are rejected', () => {
    expect(invalid({ ...payload(), kind: 'REFUND' }).code).toBe('REFERENCE_REQUIRED');
    invalid({ ...payload(), unexpected: 'x' });
  });
});

describe('SQS message parsing', () => {
  const envelope = (data: Record<string, unknown>) =>
    JSON.stringify({ messageId: 'msg-123', type: 'WagerTransactionRequested', occurredAt: '2026-07-29T15:00:00.000Z', data });

  test('parses the documented message and derives the same payload hash as HTTP', () => {
    const parsed = parseWagerMessage(envelope({ ...payload(), idempotencyKey: 'provider-a:transaction-123' }));
    const http = parseSubmitWagerTransactionCommand(payload(), 'provider-a:transaction-123');
    expect(parsed.messageId).toBe('msg-123');
    expect(parsed.correlationId).toBe('msg-123');
    expect(parsed.command.payloadHash).toBe(http.payloadHash);
  });

  test('malformed bodies are invalid (→ DLQ)', () => {
    expect(() => parseWagerMessage('not json')).toThrow(InvalidCommandError);
    expect(() => parseWagerMessage(JSON.stringify({ type: 'Other' }))).toThrow(InvalidCommandError);
    expect(() => parseWagerMessage(envelope(payload()))).toThrow(InvalidCommandError); // no idempotencyKey
  });
});
