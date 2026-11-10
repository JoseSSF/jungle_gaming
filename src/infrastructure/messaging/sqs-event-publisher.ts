import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishResult } from '../../application/ports/event-publisher';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { SqsQueues } from './sqs-queues';

/**
 * Publishes outbox events to `wagering-events.fifo`.
 *  - MessageGroupId = aggregateId (ordering per aggregate is a broker optimization only);
 *  - MessageDeduplicationId = eventId (broker drops re-publications within 5 minutes;
 *    consumers must still dedupe by eventId — at-least-once is the contract).
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: SqsQueues,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishResult> {
    const succeeded = new Set<string>();
    const failed = new Map<string, string>();
    if (messages.length === 0) return { succeeded, failed };

    const queueUrl = await this.queues.url('events');
    for (let offset = 0; offset < messages.length; offset += 10) {
      const chunk = messages.slice(offset, offset + 10);
      const output = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: chunk.map((message, index) => ({
            Id: `e${index}`,
            MessageBody: JSON.stringify(message.payload),
            MessageGroupId: message.aggregateId,
            MessageDeduplicationId: message.id,
            MessageAttributes: {
              eventType: { DataType: 'String', StringValue: message.eventType },
              eventId: { DataType: 'String', StringValue: message.id },
              eventVersion: { DataType: 'Number', StringValue: String(message.eventVersion) },
            },
          })),
        }),
      );
      for (const entry of output.Successful ?? []) {
        const index = Number(entry.Id?.slice(1));
        const message = chunk[index];
        if (message) succeeded.add(message.id);
      }
      for (const entry of output.Failed ?? []) {
        const index = Number(entry.Id?.slice(1));
        const message = chunk[index];
        if (message) failed.set(message.id, `${entry.Code ?? 'Error'}: ${entry.Message ?? 'publish failed'}`);
      }
    }
    return { succeeded, failed };
  }
}
