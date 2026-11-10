import { hostname } from 'node:os';
import { z } from 'zod';

export const WORKER_ROLES = ['consumer', 'outbox', 'pending-references'] as const;
export type WorkerRole = (typeof WORKER_ROLES)[number];

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');
const int = (fallback: number) => z.coerce.number().int().nonnegative().default(fallback);

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: int(3000),
  INSTANCE_ID: z.string().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  WORKERS: z.string().default('consumer,outbox,pending-references'),

  DATABASE_URL: z.string().default('postgres://wagering:wagering@localhost:5432/wagering'),
  DATABASE_POOL_MAX: int(10),
  DATABASE_STATEMENT_TIMEOUT_MS: int(10_000),
  DATABASE_CONNECT_TIMEOUT_MS: int(5_000),
  WALLET_LOCK_TIMEOUT_MS: int(3_000),
  SUBMIT_MAX_CONFLICT_RETRIES: int(5),

  SQS_ENDPOINT: z.string().default('http://localhost:4566'),
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().default('test'),
  SQS_QUEUE_NAME: z.string().default('wager-transactions.fifo'),
  SQS_DLQ_NAME: z.string().default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE_NAME: z.string().default('wagering-events.fifo'),
  SQS_AUTO_CREATE_QUEUES: bool.default('true'),
  SQS_WAIT_TIME_SECONDS: int(10),
  SQS_MAX_MESSAGES: int(10),
  SQS_VISIBILITY_TIMEOUT_SECONDS: int(30),
  SQS_MAX_ATTEMPTS: int(5),
  SQS_RETRY_BASE_DELAY_SECONDS: int(2),
  SQS_RETRY_MAX_DELAY_SECONDS: int(60),
  SQS_SHUTDOWN_GRACE_MS: int(20_000),

  OUTBOX_POLL_INTERVAL_MS: int(250),
  OUTBOX_BATCH_SIZE: int(10),
  OUTBOX_BACKOFF_BASE_MS: int(1_000),
  OUTBOX_BACKOFF_MAX_MS: int(60_000),
  OUTBOX_METRICS_INTERVAL_MS: int(5_000),

  PENDING_REFERENCE_POLL_INTERVAL_MS: int(1_000),
  PENDING_REFERENCE_BATCH_SIZE: int(50),
  PENDING_REFERENCE_BASE_DELAY_MS: int(1_000),
  PENDING_REFERENCE_MAX_DELAY_MS: int(60_000),
  PENDING_REFERENCE_MAX_ATTEMPTS: int(12),
  PENDING_REFERENCE_TTL_MS: int(15 * 60_000),

  AUTH_MODE: z.enum(['keycloak', 'disabled']).default('disabled'),
  AUTH_ISSUER: z.string().default('http://localhost:8080/realms/jungle'),
  AUTH_JWKS_URL: z.string().default('http://localhost:8080/realms/jungle/protocol/openid-connect/certs'),
  AUTH_AUDIENCE: z.string().default('wagering-api'),

  /** Comma-separated FaultPoint list. Test-only crash points; empty in production. */
  FAULT_INJECTION: z.string().default(''),
});

export interface AppConfig {
  env: string;
  port: number;
  instanceId: string;
  logLevel: string;
  workers: ReadonlySet<WorkerRole>;
  database: {
    url: string;
    poolMax: number;
    statementTimeoutMs: number;
    connectTimeoutMs: number;
    walletLockTimeoutMs: number;
    maxConflictRetries: number;
  };
  sqs: {
    endpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    queueName: string;
    dlqName: string;
    eventsQueueName: string;
    autoCreateQueues: boolean;
    waitTimeSeconds: number;
    maxMessages: number;
    visibilityTimeoutSeconds: number;
    maxAttempts: number;
    retryBaseDelaySeconds: number;
    retryMaxDelaySeconds: number;
    shutdownGraceMs: number;
  };
  outbox: {
    pollIntervalMs: number;
    batchSize: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
    metricsIntervalMs: number;
  };
  pendingReferences: {
    pollIntervalMs: number;
    batchSize: number;
    baseDelayMs: number;
    maxDelayMs: number;
    maxAttempts: number;
    ttlMs: number;
  };
  auth: {
    mode: 'keycloak' | 'disabled';
    issuer: string;
    jwksUrl: string;
    audience: string;
  };
  faultInjection: ReadonlySet<string>;
}

function parseWorkers(raw: string): Set<WorkerRole> {
  const value = raw.trim();
  if (value === '' || value === 'none') return new Set();
  const roles = value.split(',').map((role) => role.trim());
  for (const role of roles) {
    if (!(WORKER_ROLES as readonly string[]).includes(role)) {
      throw new Error(`Invalid WORKERS entry "${role}". Allowed: ${WORKER_ROLES.join(', ')} or "none"`);
    }
  }
  return new Set(roles as WorkerRole[]);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid configuration: ${details}`);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    instanceId: e.INSTANCE_ID ?? `${hostname()}-${process.pid}`,
    logLevel: e.LOG_LEVEL,
    workers: parseWorkers(e.WORKERS),
    database: {
      url: e.DATABASE_URL,
      poolMax: Math.max(2, e.DATABASE_POOL_MAX),
      statementTimeoutMs: e.DATABASE_STATEMENT_TIMEOUT_MS,
      connectTimeoutMs: e.DATABASE_CONNECT_TIMEOUT_MS,
      walletLockTimeoutMs: e.WALLET_LOCK_TIMEOUT_MS,
      maxConflictRetries: Math.max(1, e.SUBMIT_MAX_CONFLICT_RETRIES),
    },
    sqs: {
      endpoint: e.SQS_ENDPOINT,
      region: e.AWS_REGION,
      accessKeyId: e.AWS_ACCESS_KEY_ID,
      secretAccessKey: e.AWS_SECRET_ACCESS_KEY,
      queueName: e.SQS_QUEUE_NAME,
      dlqName: e.SQS_DLQ_NAME,
      eventsQueueName: e.SQS_EVENTS_QUEUE_NAME,
      autoCreateQueues: e.SQS_AUTO_CREATE_QUEUES,
      waitTimeSeconds: Math.min(20, e.SQS_WAIT_TIME_SECONDS),
      maxMessages: Math.min(10, Math.max(1, e.SQS_MAX_MESSAGES)),
      visibilityTimeoutSeconds: Math.max(1, e.SQS_VISIBILITY_TIMEOUT_SECONDS),
      maxAttempts: Math.max(1, e.SQS_MAX_ATTEMPTS),
      retryBaseDelaySeconds: Math.max(1, e.SQS_RETRY_BASE_DELAY_SECONDS),
      retryMaxDelaySeconds: Math.min(43_200, Math.max(1, e.SQS_RETRY_MAX_DELAY_SECONDS)),
      shutdownGraceMs: e.SQS_SHUTDOWN_GRACE_MS,
    },
    outbox: {
      pollIntervalMs: Math.max(10, e.OUTBOX_POLL_INTERVAL_MS),
      batchSize: Math.min(10, Math.max(1, e.OUTBOX_BATCH_SIZE)),
      backoffBaseMs: e.OUTBOX_BACKOFF_BASE_MS,
      backoffMaxMs: e.OUTBOX_BACKOFF_MAX_MS,
      metricsIntervalMs: Math.max(100, e.OUTBOX_METRICS_INTERVAL_MS),
    },
    pendingReferences: {
      pollIntervalMs: Math.max(10, e.PENDING_REFERENCE_POLL_INTERVAL_MS),
      batchSize: Math.max(1, e.PENDING_REFERENCE_BATCH_SIZE),
      baseDelayMs: e.PENDING_REFERENCE_BASE_DELAY_MS,
      maxDelayMs: e.PENDING_REFERENCE_MAX_DELAY_MS,
      maxAttempts: Math.max(1, e.PENDING_REFERENCE_MAX_ATTEMPTS),
      ttlMs: e.PENDING_REFERENCE_TTL_MS,
    },
    auth: {
      mode: e.AUTH_MODE,
      issuer: e.AUTH_ISSUER,
      jwksUrl: e.AUTH_JWKS_URL,
      audience: e.AUTH_AUDIENCE,
    },
    faultInjection: new Set(
      e.FAULT_INJECTION.split(',')
        .map((point) => point.trim())
        .filter((point) => point.length > 0),
    ),
  };
}
