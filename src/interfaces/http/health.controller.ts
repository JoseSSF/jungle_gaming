import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { type BeforeApplicationShutdown, Controller, Get, Header, Inject, Injectable, Res } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Response } from 'express';
import { TOKENS } from '../../app.tokens';
import type { AppConfig } from '../../config/app-config';
import type { SqsQueues } from '../../infrastructure/messaging/sqs-queues';
import type { AppMetrics } from '../../infrastructure/observability/metrics';
import { Public } from './auth.guard';

interface CheckResult {
  status: 'up' | 'down';
  latencyMs: number;
  error?: string;
}

const CHECK_TIMEOUT_MS = 2_000;

async function timed(check: () => Promise<unknown>): Promise<CheckResult> {
  const started = performance.now();
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${CHECK_TIMEOUT_MS}ms`)), CHECK_TIMEOUT_MS)),
    ]);
    return { status: 'up', latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      status: 'down',
      latencyMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message.slice(0, 200) : 'unknown error',
    };
  }
}

@Injectable()
export class HealthService implements BeforeApplicationShutdown {
  private shuttingDown = false;

  constructor(
    @Inject(TOKENS.orm) private readonly orm: MikroORM,
    @Inject(TOKENS.sqsClient) private readonly sqs: SQSClient,
    @Inject(TOKENS.sqsQueues) private readonly queues: SqsQueues,
  ) {}

  beforeApplicationShutdown(): void {
    // Stop receiving traffic from the load balancer as soon as shutdown starts.
    this.shuttingDown = true;
  }

  async readiness() {
    const [database, sqs] = await Promise.all([
      timed(() => this.orm.em.fork().getConnection().execute('SELECT 1')),
      timed(async () => {
        const url = await this.queues.url('main');
        await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }));
      }),
    ]);
    const ready = !this.shuttingDown && database.status === 'up' && sqs.status === 'up';
    return { ready, body: { status: ready ? 'ready' : 'unavailable', shuttingDown: this.shuttingDown, checks: { database, sqs } } };
  }
}

/** Health endpoints never require authentication. */
@Controller('health')
@Public()
export class HealthController {
  constructor(
    @Inject(HealthService) private readonly health: HealthService,
    @Inject(TOKENS.config) private readonly config: AppConfig,
  ) {}

  @Get('live')
  live() {
    return { status: 'alive', instanceId: this.config.instanceId, uptimeSeconds: Math.round(process.uptime()) };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response) {
    const { ready, body } = await this.health.readiness();
    response.status(ready ? 200 : 503);
    return { ...body, instanceId: this.config.instanceId };
  }
}

@Controller('metrics')
@Public()
export class MetricsController {
  constructor(@Inject(TOKENS.metrics) private readonly metrics: AppMetrics) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async scrape(@Res() response: Response): Promise<void> {
    response.setHeader('Content-Type', this.metrics.registry.contentType);
    response.send(await this.metrics.registry.metrics());
  }
}
