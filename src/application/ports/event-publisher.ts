import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface PublishResult {
  /** Ids (eventIds) acknowledged by the broker. */
  succeeded: ReadonlySet<string>;
  /** Per-message failure reasons. */
  failed: ReadonlyMap<string, string>;
}

/** Broker port used by the outbox relay. Must be safe to call more than once per event. */
export interface EventPublisher {
  publish(messages: readonly OutboxMessage[]): Promise<PublishResult>;
}
