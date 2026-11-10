import { createServer } from 'node:net';
import { v7 as uuidv7 } from 'uuid';

/** Real infrastructure used by integration/concurrency suites (docker compose services). */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering_test';
export const TEST_SQS_ENDPOINT = process.env.TEST_SQS_ENDPOINT ?? 'http://localhost:4566';

export type Env = Record<string, string>;

/** Short timings so retries/backoffs/visibility timeouts are observable in seconds. */
export function testEnv(overrides: Env = {}): Env {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'warn',
    PORT: '0',
    WORKERS: 'none',
    DATABASE_URL: TEST_DATABASE_URL,
    DATABASE_POOL_MAX: '10',
    WALLET_LOCK_TIMEOUT_MS: '5000',
    SUBMIT_MAX_CONFLICT_RETRIES: '8',
    SQS_ENDPOINT: TEST_SQS_ENDPOINT,
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    SQS_AUTO_CREATE_QUEUES: 'true',
    SQS_WAIT_TIME_SECONDS: '1',
    SQS_MAX_MESSAGES: '10',
    SQS_VISIBILITY_TIMEOUT_SECONDS: '5',
    SQS_MAX_ATTEMPTS: '3',
    SQS_RETRY_BASE_DELAY_SECONDS: '1',
    SQS_RETRY_MAX_DELAY_SECONDS: '2',
    SQS_SHUTDOWN_GRACE_MS: '10000',
    OUTBOX_POLL_INTERVAL_MS: '50',
    OUTBOX_BATCH_SIZE: '10',
    OUTBOX_BACKOFF_BASE_MS: '200',
    OUTBOX_BACKOFF_MAX_MS: '1000',
    OUTBOX_METRICS_INTERVAL_MS: '500',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '100',
    PENDING_REFERENCE_BATCH_SIZE: '50',
    PENDING_REFERENCE_BASE_DELAY_MS: '200',
    PENDING_REFERENCE_MAX_DELAY_MS: '1000',
    PENDING_REFERENCE_MAX_ATTEMPTS: '6',
    PENDING_REFERENCE_TTL_MS: '120000',
    AUTH_MODE: 'disabled',
    FAULT_INJECTION: '',
    ...overrides,
  };
}

/** Isolated FIFO queues per test file (names must end with .fifo, ≤ 80 chars). */
export function uniqueQueues(label: string): Env {
  const suffix = `${label}-${uuidv7().slice(-12)}`.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 40);
  return {
    SQS_QUEUE_NAME: `t-${suffix}-wagers.fifo`,
    SQS_DLQ_NAME: `t-${suffix}-wagers-dlq.fifo`,
    SQS_EVENTS_QUEUE_NAME: `t-${suffix}-events.fifo`,
  };
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `probe` until it returns a truthy value or the timeout elapses. */
export async function eventually<T>(probe: () => Promise<T | undefined | null | false>, timeoutMs = 20_000, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Condition not met within ${timeoutMs}ms${last ? `: ${String(last)}` : ''}`);
}
