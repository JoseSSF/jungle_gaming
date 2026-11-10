import type { IntegrationEvent, IntegrationEventEnvelope } from '../events/integration-event';
import { type ExponentialBackoff, exponentialDelayMs } from '../shared/backoff';
import { InvalidTransactionStateError } from '../shared/domain-error';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
  lastError?: string;
}

export const DEFAULT_OUTBOX_BACKOFF: ExponentialBackoff = Object.freeze({ baseDelayMs: 1_000, maxDelayMs: 60_000 });

/**
 * Integration event waiting to be published (Transactional Outbox).
 * Written in the same SQL transaction as the state change it describes; published
 * by a worker only after commit. `id` === `eventId`, so duplicates are recognizable.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly eventVersion: number,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
    private _lastError?: string,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const envelope: IntegrationEventEnvelope<unknown> = event.toJSON();
    // Deep-freeze a JSON copy: the stored payload is exactly what will be published.
    const payload = deepFreeze(JSON.parse(JSON.stringify(envelope)) as Record<string, unknown>);
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.version,
      payload,
      event.occurredAt,
      0,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.eventVersion,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.lastError,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError(`Outbox message ${this.id} already published`);
    }
    this._publishedAt = at;
    this._lastError = undefined;
  }

  /** Increments attempts and computes the next attempt time (capped exponential backoff). */
  scheduleRetry(now: Date, error?: string, policy: ExponentialBackoff = DEFAULT_OUTBOX_BACKOFF): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError(`Outbox message ${this.id} already published`);
    }
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + exponentialDelayMs(policy, this._attempts));
    this._lastError = error?.slice(0, 1000);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
