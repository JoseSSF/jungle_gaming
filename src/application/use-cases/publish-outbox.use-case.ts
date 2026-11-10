import type { ExponentialBackoff } from '../../domain/shared/backoff';
import type { EventPublisher, PublishResult } from '../ports/event-publisher';
import type { UnitOfWork } from '../ports/repositories';
import type { Clock, FaultInjector, Logger, WageringMetrics } from '../ports/runtime';

export interface PublishOutboxConfig {
  batchSize: number;
  backoff: ExponentialBackoff;
}

/**
 * Outbox relay. Each call claims a batch of due events with `FOR UPDATE SKIP LOCKED`,
 * publishes them and marks them published — all while holding the row locks, so two
 * publishers (instances) never publish the same row concurrently.
 *
 * Guarantee: at-least-once. If the process dies after the broker accepted the batch but
 * before COMMIT, the rows stay unpublished and another instance re-publishes them with
 * the same eventId (FIFO MessageDeduplicationId = eventId; consumers dedupe by eventId).
 * Nothing is ever lost: rows are deleted never, and only marked after broker ack.
 */
export class PublishOutboxUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly metrics: WageringMetrics,
    private readonly logger: Logger,
    private readonly faults: FaultInjector,
    private readonly config: PublishOutboxConfig,
  ) {}

  /** Returns how many messages were claimed (0 = nothing due). */
  async publishOnce(): Promise<number> {
    return this.uow.run(async (repos) => {
      const batch = await repos.outbox.claimDue(this.clock.now(), this.config.batchSize);
      if (batch.length === 0) return 0;
      this.faults.trigger('outbox-after-claim');

      let result: PublishResult;
      try {
        result = await this.publisher.publish(batch);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        result = { succeeded: new Set(), failed: new Map(batch.map((message) => [message.id, reason])) };
      }
      this.faults.trigger('outbox-after-publish-before-commit');

      const now = this.clock.now();
      for (const message of batch) {
        if (result.succeeded.has(message.id)) {
          message.markPublished(now);
          this.metrics.outboxPublished(message.eventType, (now.getTime() - message.occurredAt.getTime()) / 1000);
        } else {
          const reason = result.failed.get(message.id) ?? 'not acknowledged by broker';
          message.scheduleRetry(now, reason, this.config.backoff);
          this.metrics.outboxPublishFailed(message.eventType);
          this.metrics.retry('outbox-publish', 'broker-error');
          this.logger.warn('outbox_publish_failed', {
            eventId: message.id,
            eventType: message.eventType,
            attempts: message.attempts,
            error: reason,
          });
        }
        await repos.outbox.save(message);
      }
      return batch.length;
    });
  }

  async refreshBacklogMetrics(): Promise<void> {
    const stats = await this.uow.run((repos) => repos.outbox.stats(), { readOnly: true });
    const oldestAge = stats.oldestPendingOccurredAt
      ? Math.max(0, (this.clock.now().getTime() - stats.oldestPendingOccurredAt.getTime()) / 1000)
      : 0;
    this.metrics.outboxBacklog(stats.pending, oldestAge);
  }
}
