import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { wagerPayload } from '../support/api';
import { type AppProcess, killAll, spawnApp, startApp } from '../support/app';
import { db, prepareDatabase, scalar } from '../support/database';
import { type Env, eventually, sleep, uniqueQueues } from '../support/env';
import { assertGlobalInvariants, walletState } from '../support/invariants';
import { flushOutbox } from '../support/outbox';
import { drain, ensureQueues, queueDepth, sendWagerMessage } from '../support/sqs';

/*
 * Process deaths at the worst possible moments, reproduced with real processes killed
 * through FAULT_INJECTION crash points (process.kill(SIGKILL) — no cleanup at all).
 */

const spawned: AppProcess[] = [];
let helper: Awaited<ReturnType<typeof startApp>>;

beforeAll(async () => {
  await prepareDatabase();
  helper = await startApp({ ...uniqueQueues('crash-helper') }); // HTTP only, used to create wallets
});

// Each scenario owns its processes: a relay left running would steal the next scenario's rows.
afterEach(async () => {
  await killAll(spawned);
  spawned.length = 0;
});

afterAll(async () => {
  await killAll(spawned);
  await helper?.close();
  await assertGlobalInvariants();
});

async function spawn(name: string, env: Env, waitReady = true): Promise<AppProcess> {
  const instance = await spawnApp(name, env, { waitReady });
  spawned.push(instance);
  return instance;
}

describe('worker killed after COMMIT and before ACK', () => {
  test('the redelivered message is absorbed by the inbox: exactly one debit', async () => {
    const env: Env = { ...uniqueQueues('ack'), WORKERS: 'consumer', SQS_VISIBILITY_TIMEOUT_SECONDS: '3' };
    const queues = await ensureQueues(env);
    const { walletId, playerId } = await helper.api.createWallet('100.00');
    const messageId = await sendWagerMessage(queues.main, wagerPayload(walletId, playerId, { amount: '30.00' }));

    const doomed = await spawn('doomed-consumer', { ...env, FAULT_INJECTION: 'consumer-after-commit-before-ack' }, false);
    const exitCode = await Promise.race([doomed.exited, sleep(30_000).then(() => 'timeout')]);
    expect(exitCode).not.toBe('timeout');

    // Committed before dying...
    expect(await walletState(walletId)).toMatchObject({ balance: '70.00', debits: 1 });
    expect(await scalar<number>('SELECT COUNT(*)::int FROM inbox_messages WHERE message_id = $1', [messageId])).toBe(1);
    // ...but never acknowledged: the message is still in the queue.
    expect(await queueDepth(queues.main)).toBe(1);

    const survivor = await spawn('survivor-consumer', env);
    await eventually(async () => (await queueDepth(queues.main)) === 0, 30_000);
    expect(await walletState(walletId)).toMatchObject({ balance: '70.00', debits: 1 });
    const metrics = String((await survivor.api.request('GET', '/metrics')).body);
    expect(metrics).toMatch(/wagering_duplicates_detected_total\{[^}]*kind="inbox-message"[^}]*\} 1/);
  }, 90_000);
});

describe('outbox relay killed', () => {
  async function trafficWithPendingEvents(): Promise<string[]> {
    // Start from an empty backlog so the doomed relay claims this test's rows.
    await flushOutbox();
    const walletIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { walletId, playerId } = await helper.api.createWallet('50.00');
      walletIds.push(walletId);
      for (let j = 0; j < 4; j += 1) await helper.api.submit(wagerPayload(walletId, playerId, { amount: '1.00' }));
    }
    return walletIds;
  }

  async function pendingIds(walletIds: string[]): Promise<string[]> {
    const result = await db().query(
      `SELECT id FROM outbox_messages WHERE published_at IS NULL AND payload->'data'->>'walletId' = ANY($1) ORDER BY id`,
      [walletIds],
    );
    return result.rows.map((row) => row.id as string);
  }

  test('commit confirmed, process dies before publishing, another instance publishes', async () => {
    const env: Env = { ...uniqueQueues('outbox-claim'), WORKERS: 'outbox' };
    const queues = await ensureQueues(env);
    const walletIds = await trafficWithPendingEvents();
    const expected = await pendingIds(walletIds);
    expect(expected.length).toBeGreaterThan(0);

    const doomed = await spawn('doomed-relay', { ...env, FAULT_INJECTION: 'outbox-after-claim' }, false);
    // Killed by the injected fault (SIGKILL): Bun reports it in signalCode, exitCode stays null.
    expect(await Promise.race([doomed.exited.then(() => 'died'), sleep(30_000).then(() => 'still running')])).toBe('died');
    expect(doomed.proc.signalCode ?? doomed.proc.exitCode).not.toBeNull();
    expect((await pendingIds(walletIds)).length).toBe(expected.length); // nothing lost, nothing marked

    await spawn('takeover-relay', env);
    await eventually(async () => (await pendingIds(walletIds)).length === 0, 30_000);
    const ids = new Set((await drain(queues.events)).map((m) => JSON.parse(m.Body ?? '{}').eventId as string));
    for (const id of expected) expect(ids.has(id)).toBe(true);
  }, 90_000);

  test('process dies after the broker accepted the batch but before COMMIT: duplicates are safe', async () => {
    const env: Env = { ...uniqueQueues('outbox-dup'), WORKERS: 'outbox' };
    const queues = await ensureQueues(env);
    const walletIds = await trafficWithPendingEvents();
    const expected = await pendingIds(walletIds);

    const doomed = await spawn('doomed-relay-2', { ...env, FAULT_INJECTION: 'outbox-after-publish-before-commit' }, false);
    // Killed by the injected fault (SIGKILL): Bun reports it in signalCode, exitCode stays null.
    expect(await Promise.race([doomed.exited.then(() => 'died'), sleep(30_000).then(() => 'still running')])).toBe('died');
    expect(doomed.proc.signalCode ?? doomed.proc.exitCode).not.toBeNull();

    await spawn('takeover-relay-2', env);
    await eventually(async () => (await pendingIds(walletIds)).length === 0, 30_000);

    const messages = await drain(queues.events);
    const bodies = messages.map((message) => JSON.parse(message.Body ?? '{}') as { eventId: string });
    // Every event arrived; any re-publication carries the same eventId (and identical body),
    // so an idempotent consumer keyed by eventId applies each event exactly once.
    const applied = new Map<string, string>();
    for (const [index, body] of bodies.entries()) {
      const previous = applied.get(body.eventId);
      if (previous) expect(messages[index]?.Body).toBe(previous);
      else applied.set(body.eventId, messages[index]?.Body ?? '');
    }
    for (const id of expected) expect(applied.has(id)).toBe(true);
    console.log(JSON.stringify({ test: 'outbox-duplicate-publication', delivered: bodies.length, unique: applied.size }));
  }, 90_000);

  test('two relays on the same outbox at the same time', async () => {
    const env: Env = { ...uniqueQueues('outbox-two'), WORKERS: 'outbox' };
    const queues = await ensureQueues(env);
    const walletIds = await trafficWithPendingEvents();
    const expected = await pendingIds(walletIds);
    const relays = await Promise.all([spawn('relay-a', env), spawn('relay-b', env)]);
    await eventually(async () => (await pendingIds(walletIds)).length === 0, 30_000);
    const totals = await Promise.all(
      relays.map(async (relay) => {
        const metrics = String((await relay.api.request('GET', '/metrics')).body);
        return [...metrics.matchAll(/^wagering_outbox_published_total\{[^}]*\} (\d+)/gm)].reduce((a, m) => a + Number(m[1]), 0);
      }),
    );
    const ids = (await drain(queues.events)).map((m) => JSON.parse(m.Body ?? '{}').eventId as string);
    for (const id of expected) expect(ids).toContain(id);
    // No row marked twice: the per-relay counters add up to the published rows they handled.
    expect(new Set(ids).size).toBe(ids.length);
    expect(totals.reduce((a, b) => a + b, 0)).toBe(ids.length);
  }, 90_000);
});
