import { z } from 'zod';
import {
  parseSubmitWagerTransactionCommand,
  type SubmitWagerTransactionCommand,
  zodIssues,
} from '../../application/commands/submit-wager-transaction.command';
import { InvalidCommandError } from '../../application/errors';
import { canonicalJson, sha256Hex } from '../../application/idempotency/payload-hash';

export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

const envelopeSchema = z.object({
  messageId: z.string().min(1).max(256),
  type: z.literal(WAGER_MESSAGE_TYPE),
  occurredAt: z.string().datetime({ offset: true }),
  /** Optional extension: propagated as correlationId when present. */
  correlationId: z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9._:\-]+$/)
    .optional(),
  data: z.record(z.unknown()),
});

export interface ParsedWagerMessage {
  messageId: string;
  correlationId: string;
  occurredAt: string;
  command: SubmitWagerTransactionCommand;
  /** Hash of type + data: detects a messageId reused with another payload. */
  messageHash: string;
}

/** Throws InvalidCommandError for malformed messages (they go to the DLQ). */
export function parseWagerMessage(body: string | undefined): ParsedWagerMessage {
  let json: unknown;
  try {
    json = JSON.parse(body ?? '');
  } catch {
    throw new InvalidCommandError('INVALID_MESSAGE', 'Message body is not valid JSON');
  }
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) {
    throw new InvalidCommandError('INVALID_MESSAGE', 'Message envelope is invalid', zodIssues(envelope.error));
  }
  const { idempotencyKey, ...payload } = envelope.data.data;
  const command = parseSubmitWagerTransactionCommand(payload, idempotencyKey);
  return {
    messageId: envelope.data.messageId,
    correlationId: envelope.data.correlationId ?? envelope.data.messageId,
    occurredAt: envelope.data.occurredAt,
    command,
    // Safe: data was fully validated (strings only) by the command parser.
    messageHash: sha256Hex(canonicalJson({ type: envelope.data.type, data: envelope.data.data })),
  };
}
