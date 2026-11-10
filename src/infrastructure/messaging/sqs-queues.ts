import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  QueueDoesNotExist,
  QueueNameExists,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../config/app-config';

export function createSqsClient(config: AppConfig): SQSClient {
  return new SQSClient({
    endpoint: config.sqs.endpoint,
    region: config.sqs.region,
    credentials: { accessKeyId: config.sqs.accessKeyId, secretAccessKey: config.sqs.secretAccessKey },
    maxAttempts: 3,
  });
}

export type QueueRole = 'main' | 'dlq' | 'events';

/**
 * Resolves (and, in local environments, creates) the queues:
 *   wager-transactions.fifo      main input queue, RedrivePolicy → DLQ (broker-side safety net)
 *   wager-transactions-dlq.fifo  dead letters (14 days retention)
 *   wagering-events.fifo         integration events published by the outbox relay
 */
export class SqsQueues {
  private readonly urls = new Map<QueueRole, string>();

  constructor(
    private readonly sqs: SQSClient,
    private readonly config: AppConfig['sqs'],
  ) {}

  names(): Record<QueueRole, string> {
    return { main: this.config.queueName, dlq: this.config.dlqName, events: this.config.eventsQueueName };
  }

  async url(role: QueueRole): Promise<string> {
    const cached = this.urls.get(role);
    if (cached) return cached;
    const name = this.names()[role];
    const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!QueueUrl) throw new Error(`Queue ${name} has no URL`);
    this.urls.set(role, QueueUrl);
    return QueueUrl;
  }

  /** Idempotent: creates the three FIFO queues if missing. */
  async ensure(): Promise<void> {
    const dlqUrl = await this.create(this.config.dlqName, {
      FifoQueue: 'true',
      ContentBasedDeduplication: 'false',
      MessageRetentionPeriod: String(14 * 24 * 3600),
    });
    this.urls.set('dlq', dlqUrl);

    const attributes = await this.sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
    );
    const dlqArn = attributes.Attributes?.QueueArn;

    const mainAttributes: Record<string, string> = {
      FifoQueue: 'true',
      ContentBasedDeduplication: 'false',
      VisibilityTimeout: String(this.config.visibilityTimeoutSeconds),
    };
    if (dlqArn) {
      // The consumer enforces SQS_MAX_ATTEMPTS itself (and dead-letters explicitly); the broker
      // redrive is a safety net for poison messages that crash the process before that check.
      mainAttributes.RedrivePolicy = JSON.stringify({
        deadLetterTargetArn: dlqArn,
        maxReceiveCount: this.config.maxAttempts + 2,
      });
    }
    this.urls.set('main', await this.create(this.config.queueName, mainAttributes));
    this.urls.set(
      'events',
      await this.create(this.config.eventsQueueName, { FifoQueue: 'true', ContentBasedDeduplication: 'false' }),
    );
  }

  private async create(name: string, attributes: Record<string, string>): Promise<string> {
    try {
      const { QueueUrl } = await this.sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
      if (!QueueUrl) throw new Error(`CreateQueue returned no URL for ${name}`);
      return QueueUrl;
    } catch (error) {
      // Queue exists with different attributes: keep the existing one.
      if (error instanceof QueueNameExists) {
        const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }));
        if (QueueUrl) return QueueUrl;
      }
      throw error;
    }
  }
}

export function isQueueMissing(error: unknown): boolean {
  return error instanceof QueueDoesNotExist || (error as { name?: string })?.name === 'AWS.SimpleQueueService.NonExistentQueue';
}
