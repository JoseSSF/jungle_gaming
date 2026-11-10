import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { v7 as uuidv7 } from 'uuid';
import { loadConfig } from '../src/config/app-config';
import { createSqsClient, SqsQueues } from '../src/infrastructure/messaging/sqs-queues';

/**
 * Publishes a WagerTransactionRequested message (manual testing).
 *
 *   bun run sqs:send -- --wallet <walletId> --player <playerId> --kind BET --amount 25.00 \
 *        [--provider provider-a] [--external tx-1] [--round r-1] [--reference tx-0] [--message-id m-1]
 */
function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value !== undefined) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name} is required`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const queues = new SqsQueues(createSqsClient(config), config.sqs);
  const sqs = createSqsClient(config);

  const providerId = arg('provider', 'provider-a');
  const externalTransactionId = arg('external', `tx-${uuidv7()}`);
  const walletId = arg('wallet');
  const reference = process.argv.includes('--reference') ? arg('reference') : undefined;
  const message = {
    messageId: arg('message-id', `msg-${uuidv7()}`),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId,
      externalTransactionId,
      idempotencyKey: `${providerId}:${externalTransactionId}`,
      playerId: arg('player'),
      walletId,
      roundId: arg('round', 'round-1'),
      gameId: arg('game', 'fortune-chimp'),
      kind: arg('kind', 'BET'),
      money: { amount: arg('amount', '10.00'), currency: arg('currency', 'BRL') },
      ...(reference ? { referenceExternalTransactionId: reference } : {}),
    },
  };
  const output = await sqs.send(
    new SendMessageCommand({
      QueueUrl: await queues.url('main'),
      MessageBody: JSON.stringify(message),
      MessageGroupId: walletId,
      MessageDeduplicationId: message.messageId,
    }),
  );
  console.log(JSON.stringify({ msg: 'message_sent', messageId: message.messageId, sqsMessageId: output.MessageId }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
