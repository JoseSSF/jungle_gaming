import { createHash } from 'node:crypto';
import type { MoneyProps } from '../../domain/money/money';

/**
 * Canonical JSON (RFC 8785 spirit, restricted to the types we use):
 *  - object keys sorted lexicographically (UTF-16 code unit order) at every level;
 *  - `undefined` properties omitted; `null` preserved;
 *  - no insignificant whitespace;
 *  - only strings / booleans / null / arrays / plain objects are accepted. Numbers are
 *    rejected on purpose: business payloads carry money as decimal strings.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`);
  }
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Business fields of a wager request. Transport metadata (headers, messageId, occurredAt) is excluded. */
export interface WagerBusinessPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  /** Normalized money (fixed scale 2), so "25.5" and "25.50" hash identically. */
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/**
 * payloadHash = hex(SHA-256(canonicalJson(subset))). The idempotency key itself is *not*
 * part of the hash: it is the lookup key, the hash detects a different payload behind it.
 */
export function wagerPayloadHash(payload: WagerBusinessPayload): string {
  const subset: WagerBusinessPayload = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { amount: payload.money.amount, currency: payload.money.currency },
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  };
  return sha256Hex(canonicalJson(subset));
}
