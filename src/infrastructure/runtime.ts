import { v7 as uuidv7 } from 'uuid';
import type { Clock, FaultInjector, FaultPoint, IdGenerator, Logger } from '../application/ports/runtime';

export const systemClock: Clock = { now: () => new Date() };

export const uuidV7Generator: IdGenerator = { next: () => uuidv7() };

/**
 * Test-only crash points, enabled exclusively through FAULT_INJECTION. When a configured
 * point is reached the process is killed abruptly (no shutdown hooks, no ack, no commit),
 * reproducing "worker died after commit and before ack" and similar failures.
 */
export class EnvFaultInjector implements FaultInjector {
  constructor(
    private readonly points: ReadonlySet<string>,
    private readonly logger: Logger,
  ) {}

  trigger(point: FaultPoint): void {
    if (!this.points.has(point)) return;
    this.logger.error('fault_injected_process_kill', { point });
    process.kill(process.pid, 'SIGKILL');
    // Fallback for platforms where self-SIGKILL is not synchronous.
    process.exit(137);
  }
}

export const noFaults: FaultInjector = { trigger: () => undefined };
