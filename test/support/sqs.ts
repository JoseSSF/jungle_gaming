import {
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { v7 as uuidv7 } from 'uuid';
import { loadConfig } from '../../src/config/app-config';
import { SqsQueues } from '../../src/infrastructure/messaging/sqs-queues';
import { type Env, TEST_SQS_ENDPOINT, testEnv } from './env';

export function testSqsClient(): SQSClient {
  return new SQSClient({
    endpoint: TEST_SQS_ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

/** Creates the queues of a test environment and returns their URLs. */
export async function ensureQueues(env: Env): Promise<{ main: string; dlq: string; events: string }> {
  const config = loadConfig(testEnv(env));
  const queues = new SqsQueues(testSqsClient(), config.sqs);
  await queues.ensure();
  return { main: await queues.url('main'), dlq: await queues.url('dlq'), events: await queues.url('events') };
}

export async function queueUrl(name: string): Promise<string> {
  const { QueueUrl } = await testSqsClient().send(new GetQueueUrlCommand({ QueueName: name }));
  if (!QueueUrl) throw new Error(`queue ${name} not found`);
  return QueueUrl;
}

export interface WagerMessageOptions {
  messageId?: string;
  idempotencyKey?: string;
  /** Broker dedup id; defaults to a fresh value so redeliveries are real duplicates at the app level. */
  deduplicationId?: string;
  body?: string;
}

export async function sendWagerMessage(
  url: string,
  data: Record<string, unknown>,
  options: WagerMessageOptions = {},
): Promise<string> {
  const messageId = options.messageId ?? `msg-${uuidv7()}`;
  const body =
    options.body ??
    JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: { ...data, idempotencyKey: options.idempotencyKey ?? `${data.providerId}:${data.externalTransactionId}` },
    });
  await testSqsClient().send(
    new SendMessageCommand({
      QueueUrl: url,
      MessageBody: body,
      MessageGroupId: String(data.walletId ?? 'group'),
      MessageDeduplicationId: options.deduplicationId ?? uuidv7(),
    }),
  );
  return messageId;
}

/** Receives (and deletes) every message currently available in a queue. */
export async function drain(url: string, waitSeconds = 1): Promise<Message[]> {
  const client = testSqsClient();
  const all: Message[] = [];
  for (;;) {
    const output = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitSeconds,
        VisibilityTimeout: 30,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['All'],
        AttributeNames: ['All'],
      }),
    );
    const messages = output.Messages ?? [];
    if (messages.length === 0) return all;
    all.push(...messages);
    await client.send(
      new DeleteMessageBatchCommand({
        QueueUrl: url,
        Entries: messages.map((message, index) => ({ Id: `d${index}`, ReceiptHandle: message.ReceiptHandle })),
      }),
    );
  }
}

/** Visible + in-flight messages. */
export async function queueDepth(url: string): Promise<number> {
  const output = await testSqsClient().send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  const attributes = output.Attributes ?? {};
  return Number(attributes.ApproximateNumberOfMessages ?? 0) + Number(attributes.ApproximateNumberOfMessagesNotVisible ?? 0);
}
