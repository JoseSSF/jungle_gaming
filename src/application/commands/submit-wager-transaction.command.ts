import { z } from 'zod';
import { Money } from '../../domain/money/money';
import { DomainError } from '../../domain/shared/domain-error';
import {
  EXTERNAL_KINDS,
  WagerTransaction,
  type WagerTransactionKind,
} from '../../domain/wagering/wager-transaction';
import { type ErrorIssue, InvalidCommandError } from '../errors';
import { wagerPayloadHash } from '../idempotency/payload-hash';

/** Identifier grammar shared by provider-side ids: visible ASCII, no whitespace. */
const identifier = (max: number) =>
  z
    .string({ required_error: 'is required', invalid_type_error: 'must be a string' })
    .min(1, 'must not be empty')
    .max(max, `must have at most ${max} characters`)
    .regex(/^[A-Za-z0-9._:@\-]+$/, 'contains invalid characters');

const moneySchema = z
  .object(
    {
      amount: z.string({ required_error: 'is required', invalid_type_error: 'must be a decimal string' }),
      currency: z.string({ required_error: 'is required', invalid_type_error: 'must be a string' }),
    },
    { required_error: 'is required', invalid_type_error: 'must be an object' },
  )
  .strict();

const kindSchema = z.string({ required_error: 'is required' }).superRefine((value, ctx) => {
  if (!(EXTERNAL_KINDS as readonly string[]).includes(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        value === 'OPENING'
          ? 'OPENING is internal and cannot be submitted'
          : `must be one of ${EXTERNAL_KINDS.join(', ')}`,
    });
  }
});

export const wagerPayloadSchema = z
  .object({
    providerId: identifier(64),
    externalTransactionId: identifier(128),
    playerId: identifier(128),
    walletId: z.string({ required_error: 'is required' }).uuid('must be a UUID'),
    roundId: identifier(128),
    gameId: identifier(128),
    kind: kindSchema,
    money: moneySchema,
    referenceExternalTransactionId: identifier(128).optional(),
  })
  .strict();

export const idempotencyKeySchema = z
  .string({ required_error: 'Idempotency-Key is required', invalid_type_error: 'Idempotency-Key must be a string' })
  .min(1, 'Idempotency-Key must not be empty')
  .max(256, 'Idempotency-Key must have at most 256 characters')
  .regex(/^[\x21-\x7E]+$/, 'Idempotency-Key must be visible ASCII without spaces');

export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  /** SHA-256 of the canonical business payload. */
  payloadHash: string;
}

export function zodIssues(error: z.ZodError, prefix = ''): ErrorIssue[] {
  return error.issues.map((issue) => ({
    path: [prefix, ...issue.path.map(String)].filter((part) => part.length > 0).join('.') || '(root)',
    message: issue.message,
  }));
}

/**
 * Single entry point used by HTTP and SQS: validates and normalizes a wager request.
 * Throws InvalidCommandError (HTTP 400 / SQS DLQ).
 */
export function parseSubmitWagerTransactionCommand(payload: unknown, idempotencyKey: unknown): SubmitWagerTransactionCommand {
  const issues: ErrorIssue[] = [];

  const key = idempotencyKeySchema.safeParse(idempotencyKey);
  if (!key.success) issues.push(...zodIssues(key.error, 'idempotencyKey'));

  const parsed = wagerPayloadSchema.safeParse(payload);
  if (!parsed.success) issues.push(...zodIssues(parsed.error));

  if (!key.success || !parsed.success) {
    throw new InvalidCommandError('INVALID_PAYLOAD', 'Request payload is invalid', issues);
  }

  const data = parsed.data;
  let money: Money;
  try {
    money = Money.from(data.money);
  } catch (error) {
    if (error instanceof DomainError) {
      throw new InvalidCommandError('INVALID_MONEY', error.message, [{ path: 'money', message: error.message }]);
    }
    throw error;
  }

  const kind = data.kind as WagerTransactionKind;
  try {
    WagerTransaction.assertValidShape({
      kind,
      money,
      externalTransactionId: data.externalTransactionId,
      referenceExternalTransactionId: data.referenceExternalTransactionId,
    });
  } catch (error) {
    if (error instanceof DomainError) {
      throw new InvalidCommandError(error.code, error.message, [{ path: 'kind', message: error.message }]);
    }
    throw error;
  }

  const normalizedMoney = money.toJSON();
  return {
    idempotencyKey: key.data,
    providerId: data.providerId,
    externalTransactionId: data.externalTransactionId,
    playerId: data.playerId,
    walletId: data.walletId.toLowerCase(),
    roundId: data.roundId,
    gameId: data.gameId,
    kind,
    money,
    referenceExternalTransactionId: data.referenceExternalTransactionId,
    payloadHash: wagerPayloadHash({
      providerId: data.providerId,
      externalTransactionId: data.externalTransactionId,
      playerId: data.playerId,
      walletId: data.walletId.toLowerCase(),
      roundId: data.roundId,
      gameId: data.gameId,
      kind,
      money: normalizedMoney,
      referenceExternalTransactionId: data.referenceExternalTransactionId,
    }),
  };
}
