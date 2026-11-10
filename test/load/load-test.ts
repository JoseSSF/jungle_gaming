/**
 * Load test — `bun run test:load`
 *
 * Drives the HTTP API (default: the nginx load balancer in front of the 3 compose replicas)
 * with a realistic mix, then measures latency percentiles, throughput, error rate,
 * concurrency conflicts (from /metrics) and outbox lag (from PostgreSQL), and finally checks
 * the financial invariants. Writes `load-report.md`.
 *
 * Env:
 *   LOAD_TARGET=http://localhost:3000   LOAD_DURATION_S=30   LOAD_CONCURRENCY=32
 *   LOAD_WALLETS=50   LOAD_HOT_SHARE=0.2   LOAD_DUPLICATE_RATE=0.05
 *   LOAD_DATABASE_URL=postgres://wagering:wagering@localhost:5432/wagering
 *   KEYCLOAK_URL=http://localhost:8080   (tokens are fetched when reachable)
 */
import { cpus, totalmem, type as osType, release } from 'node:os';
import { writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';

const target = process.env.LOAD_TARGET ?? 'http://localhost:3000';
const durationMs = Number(process.env.LOAD_DURATION_S ?? 30) * 1000;
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 32);
const walletCount = Number(process.env.LOAD_WALLETS ?? 50);
const hotShare = Number(process.env.LOAD_HOT_SHARE ?? 0.2);
const duplicateRate = Number(process.env.LOAD_DUPLICATE_RATE ?? 0.05);
const databaseUrl = process.env.LOAD_DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering';
const keycloakUrl = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';

interface Sample {
  op: string;
  hot: boolean;
  status: number;
  ms: number;
}

async function token(clientId: string, secret: string): Promise<string | undefined> {
  try {
    const response = await fetch(`${keycloakUrl}/realms/jungle/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return undefined;
    return ((await response.json()) as { access_token: string }).access_token;
  } catch {
    return undefined;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

/** Scrapes /metrics several times through the LB and keeps the latest value per instance. */
async function scrapeCounters(names: string[]): Promise<Record<string, number>> {
  const perInstance = new Map<string, Record<string, number>>();
  for (let i = 0; i < 12; i += 1) {
    try {
      const text = await (await fetch(`${target}/metrics`)).text();
      const instance = /instance_id="([^"]+)"/.exec(text)?.[1] ?? 'unknown';
      const values: Record<string, number> = {};
      for (const name of names) {
        values[name] = [...text.matchAll(new RegExp(`^${name}(?:\\{[^}]*\\})? ([0-9.e+-]+)`, 'gm'))].reduce(
          (acc, match) => acc + Number(match[1]),
          0,
        );
      }
      perInstance.set(instance, values);
    } catch {
      // ignore
    }
  }
  const totals: Record<string, number> = {};
  for (const values of perInstance.values()) {
    for (const [name, value] of Object.entries(values)) totals[name] = (totals[name] ?? 0) + value;
  }
  totals.instancesSeen = perInstance.size;
  return totals;
}

async function main(): Promise<void> {
  const providerToken = await token('provider-a', 'provider-a-local-secret');
  const operatorToken = await token('backoffice', 'backoffice-local-secret');
  const headers = (bearer?: string, extra: Record<string, string> = {}) => ({
    'content-type': 'application/json',
    ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    ...extra,
  });

  // ---------------------------------------------------------------- setup
  const wallets: Array<{ walletId: string; playerId: string; bets: string[] }> = [];
  for (let i = 0; i < walletCount; i += 1) {
    const playerId = `load-${uuidv7()}`;
    const response = await fetch(`${target}/wallets`, {
      method: 'POST',
      headers: headers(operatorToken),
      body: JSON.stringify({ playerId, initialBalance: { amount: '1000000.00', currency: 'BRL' } }),
    });
    if (response.status !== 201) throw new Error(`wallet setup failed: ${response.status} ${await response.text()}`);
    wallets.push({ walletId: ((await response.json()) as { id: string }).id, playerId, bets: [] });
  }
  const metricNames = [
    'wagering_concurrency_conflicts_total',
    'wagering_retries_total',
    'wagering_duplicates_detected_total',
    'wagering_wallet_lock_wait_seconds_sum',
    'wagering_wallet_lock_wait_seconds_count',
  ];
  const before = await scrapeCounters(metricNames);
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const runStartedAt = new Date();

  // ---------------------------------------------------------------- run
  const samples: Sample[] = [];
  let networkErrors = 0;
  const sent: Array<{ payload: Record<string, unknown> }> = [];
  const deadline = Date.now() + durationMs;
  const hot = wallets[0];
  if (!hot) throw new Error('no wallets');

  async function submit(op: string, payload: Record<string, unknown>): Promise<void> {
    const started = performance.now();
    try {
      const response = await fetch(`${target}/wagering/transactions`, {
        method: 'POST',
        headers: headers(providerToken, { 'idempotency-key': `provider-a:${payload.externalTransactionId}` }),
        body: JSON.stringify(payload),
      });
      await response.arrayBuffer();
      samples.push({ op, hot: payload.walletId === hot?.walletId, status: response.status, ms: performance.now() - started });
    } catch {
      networkErrors += 1;
    }
  }

  async function worker(): Promise<void> {
    while (Date.now() < deadline) {
      const wallet = Math.random() < hotShare ? hot : wallets[Math.floor(Math.random() * wallets.length)];
      if (!wallet) continue;
      const dice = Math.random();
      if (dice < duplicateRate && sent.length > 0) {
        const previous = sent[Math.floor(Math.random() * sent.length)];
        if (previous) await submit('DUPLICATE', previous.payload);
        continue;
      }
      const base = {
        providerId: 'provider-a',
        externalTransactionId: `load-${uuidv7()}`,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: `round-${Math.floor(Math.random() * 1000)}`,
        gameId: 'fortune-chimp',
      };
      let payload: Record<string, unknown>;
      let op: string;
      if (dice < 0.7 || wallet.bets.length === 0) {
        op = 'BET';
        payload = { ...base, kind: 'BET', money: { amount: '1.00', currency: 'BRL' } };
        wallet.bets.push(JSON.stringify({ id: base.externalTransactionId, round: base.roundId }));
      } else if (dice < 0.88) {
        op = 'WIN';
        payload = { ...base, kind: 'WIN', money: { amount: '1.50', currency: 'BRL' } };
      } else if (dice < 0.94) {
        op = 'LOSS';
        payload = { ...base, kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } };
      } else {
        op = 'REFUND';
        const bet = JSON.parse(wallet.bets.shift() as string) as { id: string; round: string };
        payload = {
          ...base,
          roundId: bet.round,
          kind: 'REFUND',
          money: { amount: '1.00', currency: 'BRL' },
          referenceExternalTransactionId: bet.id,
        };
      }
      sent.push({ payload });
      await submit(op, payload);
    }
  }

  const lagSamples: number[] = [];
  const lagSampler = setInterval(async () => {
    const result = await pool
      .query(`SELECT COALESCE(EXTRACT(EPOCH FROM now() - MIN(occurred_at)), 0) AS lag FROM outbox_messages WHERE published_at IS NULL`)
      .catch(() => undefined);
    if (result) lagSamples.push(Number(result.rows[0]?.lag ?? 0));
  }, 1000);

  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const elapsedS = (performance.now() - started) / 1000;
  clearInterval(lagSampler);

  // ---------------------------------------------------------------- drain + verify
  const drainStarted = Date.now();
  for (;;) {
    const pending = await pool.query('SELECT COUNT(*)::int AS n FROM outbox_messages WHERE published_at IS NULL');
    if (pending.rows[0]?.n === 0 || Date.now() - drainStarted > 60_000) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const after = await scrapeCounters(metricNames);
  const publishLag = await pool.query(
    `SELECT percentile_cont(ARRAY[0.5, 0.95, 0.99]) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM published_at - occurred_at)) AS p,
            MAX(EXTRACT(EPOCH FROM published_at - occurred_at)) AS max, COUNT(*)::int AS n
       FROM outbox_messages WHERE occurred_at >= $1 AND published_at IS NOT NULL`,
    [runStartedAt],
  );
  const invariant = await pool.query(
    `SELECT COUNT(*)::int AS broken FROM (
       SELECT w.id FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
        WHERE w.id = ANY($1) GROUP BY w.id
       HAVING w.balance <> COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)) x`,
    [wallets.map((w) => w.walletId)],
  );
  await pool.end();

  // ---------------------------------------------------------------- report
  const latencies = samples.map((s) => s.ms).sort((a, b) => a - b);
  const hotLatencies = samples.filter((s) => s.hot).map((s) => s.ms).sort((a, b) => a - b);
  const coldLatencies = samples.filter((s) => !s.hot).map((s) => s.ms).sort((a, b) => a - b);
  const pct = (sorted: number[]) => `${fmt(percentile(sorted, 50))} / ${fmt(percentile(sorted, 95))} / ${fmt(percentile(sorted, 99))}`;
  const byStatus = samples.reduce<Record<string, number>>((acc, s) => {
    acc[s.status] = (acc[s.status] ?? 0) + 1;
    return acc;
  }, {});
  const byOp = samples.reduce<Record<string, number>>((acc, s) => {
    acc[s.op] = (acc[s.op] ?? 0) + 1;
    return acc;
  }, {});
  const errors = samples.filter((s) => s.status >= 500).length + networkErrors;
  const delta = (name: string) => (after[name] ?? 0) - (before[name] ?? 0);
  const lockWaitAvgMs =
    delta('wagering_wallet_lock_wait_seconds_count') > 0
      ? (delta('wagering_wallet_lock_wait_seconds_sum') / delta('wagering_wallet_lock_wait_seconds_count')) * 1000
      : 0;
  const lagRow = publishLag.rows[0] as { p: number[] | null; max: number | null; n: number };
  const fmt = (value: number) => value.toFixed(1);

  const report = `# Load test report

## Environment
- Date: ${new Date().toISOString()}
- Host: ${osType()} ${release()}, ${cpus().length} vCPU (${cpus()[0]?.model ?? 'unknown'}), ${(totalmem() / 1024 ** 3).toFixed(1)} GiB RAM
- Runtime (load generator): Bun ${Bun.version}
- Target: ${target} (instances observed via /metrics: ${after.instancesSeen ?? 0})
- Auth: ${providerToken ? 'Keycloak tokens' : 'none (AUTH_MODE=disabled)'}

## Methodology
- ${concurrency} closed-loop virtual users for ${durationMs / 1000}s, each sending the next request as soon as the previous one returns.
- ${walletCount} wallets (1,000,000.00 BRL each); ${Math.round(hotShare * 100)}% of the operations target ONE hot wallet.
- Mix: ~70% BET 1.00, ~18% WIN 1.50, ~6% LOSS, ~6% REFUND of an earlier BET of the same wallet; ${Math.round(duplicateRate * 100)}% of requests are exact re-sends of an earlier request (idempotent replay).
- Latency measured client-side (includes nginx + network). Outbox lag measured in PostgreSQL (published_at − occurred_at).

## Results
| Metric | Value |
|---|---|
| Requests | ${samples.length} (${Object.entries(byOp).map(([k, v]) => `${k} ${v}`).join(', ')}) |
| Throughput | ${fmt(samples.length / elapsedS)} req/s |
| Latency p50 / p95 / p99 / max | ${fmt(percentile(latencies, 50))} / ${fmt(percentile(latencies, 95))} / ${fmt(percentile(latencies, 99))} / ${fmt(latencies.at(-1) ?? 0)} ms |
| — hot wallet only (${hotLatencies.length} req) p50 / p95 / p99 | ${pct(hotLatencies)} ms |
| — other ${walletCount - 1} wallets (${coldLatencies.length} req) p50 / p95 / p99 | ${pct(coldLatencies)} ms |
| Status codes | ${Object.entries(byStatus).map(([k, v]) => `${k}: ${v}`).join(', ')} |
| Error rate (5xx + network) | ${((errors / Math.max(1, samples.length + networkErrors)) * 100).toFixed(3)}% (${errors}) |
| Idempotent replays detected (server) | ${delta('wagering_duplicates_detected_total')} |
| Concurrency conflicts (lock timeout / deadlock / unique race / version) | ${delta('wagering_concurrency_conflicts_total')} |
| In-process retries | ${delta('wagering_retries_total')} |
| Avg wallet lock wait | ${fmt(lockWaitAvgMs)} ms |
| Outbox lag during run (oldest pending, sampled 1/s) max | ${fmt(Math.max(0, ...lagSamples) * 1000)} ms |
| Outbox publish lag p50 / p95 / p99 / max | ${(lagRow.p ?? [0, 0, 0]).map((v) => fmt(Number(v) * 1000)).join(' / ')} / ${fmt(Number(lagRow.max ?? 0) * 1000)} ms (${lagRow.n} events) |
| Wallets where balance ≠ ledger | ${invariant.rows[0]?.broken} |
`;
  console.log(report);
  writeFileSync('load-report.md', report);
  if (Number(invariant.rows[0]?.broken) !== 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
