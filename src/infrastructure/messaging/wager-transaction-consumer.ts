import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { ApplicationError } from '../../application/errors';
import type { FaultInjector, Logger } from '../../application/ports/runtime';
import { sleep } from '../../application/support/retry';
import type { SubmitWagerTransactionUseCase } from '../../application/use-cases/submit-wager-transaction.use-case';
import { exponentialDelayMs } from '../../domain/shared/backoff';
import type { AppConfig } from '../../config/app-config';
import type { AppMetrics } from '../observability/metrics';
import { enrichContext, runWithContext } from '../observability/request-context';
import type { SqsQueues } from './sqs-queues';
import { type ParsedWagerMessage, parseWagerMessage } from './wager-message';

export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';

type Disposition = 'acked' | 'retried' | 'dead_lettered' | 'released';

/**
 * SQS consumer for wager-transactions.fifo.
 *
 * - Reuses the HTTP use case; deduplication through the persistent inbox
 *   (consumerName, messageId) written in the same SQL transaction.
 * - DeleteMessage (ack) only after the use case committed.
 * - Business outcomes (PROCESSED/REJECTED/PENDING_REFERENCE/duplicate) → ack.
 *   Transient errors → visibility backoff (retry); after SQS_MAX_ATTEMPTS → DLQ.
 *   Invalid payload / idempotency conflict / permanent errors → DLQ immediately.
 * - SIGTERM: stop receiving, finish in-flight messages (bounded by a grace period) and
 *   return the visibility of messages that were received but not started.
 * - Messages of the same MessageGroupId (walletId) in a batch run sequentially; different
 *   groups run in parallel. Correctness never depends on it (DB locks do).
 */
export class WagerTransactionConsumer {
  private running = false;
  private loopPromise: Promise<void> | undefined;
  private abortController = new AbortController();

  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: SqsQueues,
    private readonly submit: SubmitWagerTransactionUseCase,
    private readonly config: AppConfig['sqs'],
    private readonly metrics: AppMetrics,
    private readonly logger: Logger,
    private readonly faults: FaultInjector,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();
    this.loopPromise = this.loop();
    this.logger.info('sqs_consumer_started', { queue: this.config.queueName });
  }

  /** Graceful stop: in-flight messages finish (bounded by SQS_SHUTDOWN_GRACE_MS). */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abortController.abort();
    const loop = this.loopPromise;
    if (loop) {
      const finished = await Promise.race([
        loop.then(() => true),
        sleep(this.config.shutdownGraceMs).then(() => false),
      ]);
      if (!finished) {
        this.logger.warn('sqs_consumer_shutdown_grace_exceeded', { graceMs: this.config.shutdownGraceMs });
      }
    }
    this.logger.info('sqs_consumer_stopped');
  }

  private async loop(): Promise<void> {
    let failures = 0;
    while (this.running) {
      let messages: Message[];
      let queueUrl: string;
      try {
        queueUrl = await this.queues.url('main');
        const output = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: this.config.maxMessages,
            WaitTimeSeconds: this.config.waitTimeSeconds,
            VisibilityTimeout: this.config.visibilityTimeoutSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
            AttributeNames: ['All'],
            MessageAttributeNames: ['All'],
          }),
          { abortSignal: this.abortController.signal },
        );
        messages = output.Messages ?? [];
        failures = 0;
      } catch (error) {
        if (!this.running) break;
        failures += 1;
        this.metrics.sqsErrors.inc({ operation: 'receive' });
        this.logger.warn('sqs_receive_failed', { error: errorMessage(error), failures });
        await sleep(exponentialDelayMs({ baseDelayMs: 500, maxDelayMs: 15_000 }, failures));
        continue;
      }
      if (messages.length > 0) await this.processBatch(queueUrl, messages);
    }
  }

  private async processBatch(queueUrl: string, messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? 'unknown';
      const list = groups.get(group) ?? [];
      list.push(message);
      groups.set(group, list);
    }
    await Promise.allSettled(
      [...groups.values()].map(async (group) => {
        for (const message of group) {
          if (!this.running) {
            await this.release(queueUrl, message);
            continue;
          }
          await this.handle(queueUrl, message);
        }
      }),
    );
  }

  private handle(queueUrl: string, message: Message): Promise<void> {
    return runWithContext({ messageId: message.MessageId }, async () => {
      const receiveCount = Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? '1', 10) || 1;
      let parsed: ParsedWagerMessage;
      try {
        parsed = parseWagerMessage(message.Body);
      } catch (error) {
        await this.deadLetter(queueUrl, message, errorCode(error), receiveCount);
        return;
      }
      enrichContext({
        messageId: parsed.messageId,
        correlationId: parsed.correlationId,
        providerId: parsed.command.providerId,
        walletId: parsed.command.walletId,
      });

      if (receiveCount > this.config.maxAttempts) {
        // Poison protection: the message already exhausted its attempts (e.g. crash loops).
        await this.deadLetter(queueUrl, message, 'MAX_ATTEMPTS_EXCEEDED', receiveCount);
        return;
      }

      try {
        const result = await this.submit.execute(parsed.command, {
          source: 'sqs',
          correlationId: parsed.correlationId,
          causationId: parsed.messageId,
          inbox: { consumerName: WAGER_CONSUMER_NAME, messageId: parsed.messageId, payloadHash: parsed.messageHash },
        });
        if (result.type === 'transaction') enrichContext({ transactionId: result.transaction.id });
        // Committed. A crash here leads to redelivery, absorbed by the inbox.
        this.faults.trigger('consumer-after-commit-before-ack');
        await this.ack(queueUrl, message, 'acked');
      } catch (error) {
        if (isTransient(error)) {
          if (receiveCount >= this.config.maxAttempts) {
            await this.deadLetter(queueUrl, message, 'RETRIES_EXHAUSTED', receiveCount);
          } else {
            await this.retryLater(queueUrl, message, receiveCount, error);
          }
          return;
        }
        await this.deadLetter(queueUrl, message, errorCode(error), receiveCount);
      }
    });
  }

  private async ack(queueUrl: string, message: Message, disposition: Disposition): Promise<void> {
    try {
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
      this.metrics.sqsMessages.inc({ outcome: disposition });
    } catch (error) {
      // Not fatal: the message will be redelivered and absorbed by the inbox.
      this.metrics.sqsErrors.inc({ operation: 'delete' });
      this.logger.warn('sqs_ack_failed', { error: errorMessage(error) });
    }
  }

  private async retryLater(queueUrl: string, message: Message, receiveCount: number, cause: unknown): Promise<void> {
    const delaySeconds = Math.ceil(
      exponentialDelayMs(
        { baseDelayMs: this.config.retryBaseDelaySeconds * 1000, maxDelayMs: this.config.retryMaxDelaySeconds * 1000 },
        receiveCount,
      ) / 1000,
    );
    this.metrics.retry('sqs-consume', errorCode(cause));
    this.logger.warn('sqs_message_retry_scheduled', { receiveCount, delaySeconds, error: errorCode(cause) });
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: delaySeconds,
        }),
      );
      this.metrics.sqsMessages.inc({ outcome: 'retried' });
    } catch (error) {
      // Falls back to the queue visibility timeout.
      this.metrics.sqsErrors.inc({ operation: 'change_visibility' });
      this.logger.warn('sqs_change_visibility_failed', { error: errorMessage(error) });
    }
  }

  private async release(queueUrl: string, message: Message): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0 }),
      );
      this.metrics.sqsMessages.inc({ outcome: 'released' });
    } catch (error) {
      this.metrics.sqsErrors.inc({ operation: 'change_visibility' });
      this.logger.warn('sqs_release_failed', { error: errorMessage(error) });
    }
  }

  /** Copies the message to the DLQ (with the reason), then deletes it from the main queue. */
  private async deadLetter(queueUrl: string, message: Message, reason: string, receiveCount: number): Promise<void> {
    try {
      const dlqUrl = await this.queues.url('dlq');
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: dlqUrl,
          MessageBody: message.Body ?? '',
          MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
          MessageDeduplicationId: (message.MessageId ?? `${Date.now()}`).slice(0, 128),
          MessageAttributes: {
            failureReason: { DataType: 'String', StringValue: reason },
            originalMessageId: { DataType: 'String', StringValue: message.MessageId ?? 'unknown' },
            receiveCount: { DataType: 'Number', StringValue: String(receiveCount) },
          },
        }),
      );
    } catch (error) {
      // Keep the message in the main queue; it will be retried / redriven by the broker.
      this.metrics.sqsErrors.inc({ operation: 'dead_letter' });
      this.logger.error('sqs_dead_letter_failed', { reason, error: errorMessage(error) });
      return;
    }
    this.metrics.sqsDeadLettered.inc({ reason });
    this.logger.error('sqs_message_dead_lettered', { reason, receiveCount });
    await this.ack(queueUrl, message, 'dead_lettered');
  }
}

function isTransient(error: unknown): boolean {
  if (error instanceof ApplicationError) return error.retryable;
  // Unknown errors are treated as transient until the attempt budget is exhausted.
  return true;
}

function errorCode(error: unknown): string {
  if (error instanceof ApplicationError) return error.code;
  return error instanceof Error ? error.name : 'UNKNOWN_ERROR';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
