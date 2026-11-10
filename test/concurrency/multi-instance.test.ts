import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { wagerPayload } from '../support/api';
import { type AppProcess, killAll, spawnApp } from '../support/app';
import { db, prepareDatabase, scalar } from '../support/database';
import { type Env, eventually, uniqueQueues } from '../support/env';
import { assertGlobalInvariants, walletState } from '../support/invariants';
import { flushOutbox } from '../support/outbox';
import { drain, ensureQueues, queueDepth, sendWagerMessage } from '../support/sqs';

/*
 * Three independent OS processes (own memory, own pools, own SQS consumers, own outbox
 * relays, own pending-reference workers) sharing PostgreSQL and SQS.
 */

const env: Env = { ...uniqueQueues('multi'), WORKERS: 'consumer,outbox,pending-references' };
let instances: AppProcess[] = [];
let queues: { main: string; dlq: string; events: string };
let publishedBefore = 0;

beforeAll(async () => {
  await prepareDatabase();
  queues = await ensureQueues(env);
  publishedBefore = await flushOutbox();
  instances = await Promise.all(['inst-1', 'inst-2', 'inst-3'].map((name) => spawnApp(name, env)));
}, 120_000);

afterAll(async () => {
  await killAll(instances);
  await assertGlobalInvariants();
});

const pick = (i: number) => instances[i % instances.length] as AppProcess;

describe('3 instances processing the same hot wallet through HTTP and SQS', () => {
  test('130 bets of 10.00 on 500.00 → exactly 50 debits, everything else rejected, no duplicates', async () => {
    const { walletId, playerId } = await pick(0).api.createWallet('500.00');

    // 100 bets over HTTP, each sent twice to two different instances (duplicates in flight).
    const httpPayloads = Array.from({ length: 100 }, () => wagerPayload(walletId, playerId, { amount: '10.00' }));
    // 30 bets over SQS, each published twice with distinct messageIds.
    const sqsPayloads = Array.from({ length: 30 }, () => wagerPayload(walletId, playerId, { amount: '10.00' }));

    await Promise.all([
      ...httpPayloads.flatMap((payload, i) => [pick(i).api.submit(payload), pick(i + 1).api.submit(payload)]),
      ...sqsPayloads.flatMap((payload) => [sendWagerMessage(queues.main, payload), sendWagerMessage(queues.main, payload)]),
    ]);
    await eventually(async () => (await queueDepth(queues.main)) === 0, 90_000);

    expect(await walletState(walletId)).toEqual({ balance: '0.00', version: 51, entries: 51, debits: 50 });
    const statuses = await db().query(
      `SELECT status, failure_code, COUNT(*)::int AS n FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET'
        GROUP BY status, failure_code ORDER BY status`,
      [walletId],
    );
    expect(statuses.rows).toEqual([
      { status: 'PROCESSED', failure_code: null, n: 50 },
      { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS', n: 80 },
    ]);
  }, 150_000);

  test('every instance took part, and the outbox relays drained every event exactly once per row', async () => {
    const participation = await Promise.all(
      instances.map(async (instance) => {
        const metrics = String((await instance.api.request('GET', '/metrics')).body);
        const sum = (name: string) =>
          [...metrics.matchAll(new RegExp(`^${name}\\{[^}]*\\} (\\d+)`, 'gm'))].reduce((acc, m) => acc + Number(m[1]), 0);
        return { http: sum('wagering_processing_duration_seconds_count'), published: sum('wagering_outbox_published_total') };
      }),
    );
    expect(participation.every((p) => p.http > 0)).toBe(true);

    await eventually(async () => (await scalar<number>('SELECT COUNT(*)::int FROM outbox_messages WHERE published_at IS NULL')) === 0, 60_000);
    const refreshed = await Promise.all(
      instances.map(async (instance) => {
        const metrics = String((await instance.api.request('GET', '/metrics')).body);
        return [...metrics.matchAll(/^wagering_outbox_published_total\{[^}]*\} (\d+)/gm)].reduce((acc, m) => acc + Number(m[1]), 0);
      }),
    );
    const publishedRows =
      (await scalar<number>('SELECT COUNT(*)::int FROM outbox_messages WHERE published_at IS NOT NULL')) - publishedBefore;
    // Each row was marked published by exactly one relay: the per-instance counters add up.
    expect(refreshed.reduce((a, b) => a + b, 0)).toBe(publishedRows);

    const events = await drain(queues.events);
    const ids = new Set(events.map((message) => JSON.parse(message.Body ?? '{}').eventId as string));
    expect(ids.size).toBe(publishedRows);
  }, 120_000);
});

describe('3 instances, many wallets in parallel', () => {
  test('20 wallets × 15 bets spread across instances and channels', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, (_, i) => pick(i).api.createWallet('15.00')));
    await Promise.all(
      wallets.flatMap(({ walletId, playerId }, w) =>
        Array.from({ length: 15 }, (_, i) => {
          const payload = wagerPayload(walletId, playerId, { amount: '1.00' });
          return i % 2 === 0 ? pick(w + i).api.submit(payload) : sendWagerMessage(queues.main, payload);
        }),
      ),
    );
    await eventually(async () => (await queueDepth(queues.main)) === 0, 90_000);
    for (const { walletId } of wallets) {
      expect(await walletState(walletId)).toEqual({ balance: '0.00', version: 16, entries: 16, debits: 15 });
    }
  }, 150_000);
});
