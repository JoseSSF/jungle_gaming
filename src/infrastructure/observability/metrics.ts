import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { ConflictReason, DuplicateKind, TransactionSource, WageringMetrics } from '../../application/ports/runtime';

const LATENCY_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const LAG_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300];

/**
 * Prometheus metrics. One registry per application instance (tests boot several apps in
 * the same process). Exposed on GET /metrics.
 */
export class AppMetrics implements WageringMetrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'Wager transactions that reached a status, by kind/status/source',
    labelNames: ['kind', 'status', 'source'] as const,
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'wagering_duplicates_detected_total',
    help: 'Duplicates detected (idempotent replays, inbox redeliveries)',
    labelNames: ['kind', 'source'] as const,
    registers: [this.registry],
  });
  private readonly idempotencyConflicts = new Counter({
    name: 'wagering_idempotency_conflicts_total',
    help: 'Same idempotency key / messageId with a different payload',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'wagering_retries_total',
    help: 'Retries performed, by operation and reason',
    labelNames: ['operation', 'reason'] as const,
    registers: [this.registry],
  });
  private readonly conflicts = new Counter({
    name: 'wagering_concurrency_conflicts_total',
    help: 'Lock timeouts, deadlocks, unique races and version mismatches',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  private readonly lockWait = new Histogram({
    name: 'wagering_wallet_lock_wait_seconds',
    help: 'Time spent acquiring the wallet row lock (SELECT ... FOR UPDATE)',
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });
  private readonly processing = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'End-to-end wager processing latency (including retries)',
    labelNames: ['source', 'outcome'] as const,
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });
  private readonly pendingReferences = new Counter({
    name: 'wagering_pending_reference_resolutions_total',
    help: 'PENDING_REFERENCE worker outcomes',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });
  private readonly reconciliations = new Counter({
    name: 'wagering_reconciliations_total',
    help: 'Reconciliation runs by result',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });
  private readonly reconciliationDivergences = new Counter({
    name: 'wagering_reconciliation_divergences_total',
    help: 'Wallets whose stored balance diverged from the ledger',
    registers: [this.registry],
  });
  private readonly outboxPublishedCounter = new Counter({
    name: 'wagering_outbox_published_total',
    help: 'Outbox events published',
    labelNames: ['event_type'] as const,
    registers: [this.registry],
  });
  private readonly outboxFailures = new Counter({
    name: 'wagering_outbox_publish_failures_total',
    help: 'Outbox publish failures (rescheduled with backoff)',
    labelNames: ['event_type'] as const,
    registers: [this.registry],
  });
  private readonly outboxPublishLag = new Histogram({
    name: 'wagering_outbox_publish_lag_seconds',
    help: 'Delay between commit (occurredAt) and broker publication',
    buckets: LAG_BUCKETS,
    registers: [this.registry],
  });
  private readonly outboxPending = new Gauge({
    name: 'wagering_outbox_pending',
    help: 'Unpublished outbox events',
    registers: [this.registry],
  });
  private readonly outboxOldestAge = new Gauge({
    name: 'wagering_outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox event (outbox lag)',
    registers: [this.registry],
  });

  readonly sqsMessages = new Counter({
    name: 'wagering_sqs_messages_total',
    help: 'Consumed SQS messages by outcome (acked/retried/dead_lettered/released)',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });
  readonly sqsDeadLettered = new Counter({
    name: 'wagering_sqs_dlq_messages_total',
    help: 'Messages moved to the DLQ, by reason',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  readonly sqsErrors = new Counter({
    name: 'wagering_sqs_errors_total',
    help: 'Errors talking to SQS, by operation',
    labelNames: ['operation'] as const,
    registers: [this.registry],
  });
  readonly httpRequests = new Histogram({
    name: 'wagering_http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });

  constructor(options: { instanceId: string; defaultMetrics?: boolean }) {
    this.registry.setDefaultLabels({ instance_id: options.instanceId });
    if (options.defaultMetrics !== false) {
      try {
        collectDefaultMetrics({ register: this.registry });
      } catch {
        // Some process metrics are not available on every runtime; business metrics still work.
      }
    }
  }

  transactionCompleted(kind: string, status: string, source: TransactionSource): void {
    this.transactions.inc({ kind, status, source });
  }

  duplicateDetected(kind: DuplicateKind, source: TransactionSource): void {
    this.duplicates.inc({ kind, source });
  }

  idempotencyConflict(source: TransactionSource): void {
    this.idempotencyConflicts.inc({ source });
  }

  retry(operation: string, reason: string): void {
    this.retries.inc({ operation, reason });
  }

  concurrencyConflict(reason: ConflictReason): void {
    this.conflicts.inc({ reason });
  }

  lockWaitSeconds(seconds: number): void {
    this.lockWait.observe(seconds);
  }

  processingSeconds(source: TransactionSource, outcome: string, seconds: number): void {
    this.processing.observe({ source, outcome }, seconds);
  }

  pendingReferenceResolution(outcome: string): void {
    this.pendingReferences.inc({ outcome });
  }

  reconciliation(consistent: boolean): void {
    this.reconciliations.inc({ result: consistent ? 'consistent' : 'divergent' });
    if (!consistent) this.reconciliationDivergences.inc();
  }

  outboxPublished(eventType: string, lagSeconds: number): void {
    this.outboxPublishedCounter.inc({ event_type: eventType });
    this.outboxPublishLag.observe(Math.max(0, lagSeconds));
  }

  outboxPublishFailed(eventType: string): void {
    this.outboxFailures.inc({ event_type: eventType });
  }

  outboxBacklog(pending: number, oldestAgeSeconds: number): void {
    this.outboxPending.set(pending);
    this.outboxOldestAge.set(oldestAgeSeconds);
  }
}
