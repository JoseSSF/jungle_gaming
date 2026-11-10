import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { createApp, type StartedApp } from '../../src/bootstrap';
import { loadConfig } from '../../src/config/app-config';
import type { AccessTokenVerifier } from '../../src/infrastructure/auth/access-token-verifier';
import { Api } from './api';
import { type Env, freePort, sleep, testEnv } from './env';

/** Boots the real application (NestJS + MikroORM + SQS) in-process. */
export async function startApp(env: Env = {}, options: { tokenVerifier?: AccessTokenVerifier } = {}): Promise<StartedApp & { api: Api }> {
  const started = await createApp(loadConfig(testEnv(env)), { shutdownHooks: false, tokenVerifier: options.tokenVerifier });
  return { ...started, api: new Api(started.url) };
}

const ROOT = join(import.meta.dir, '..', '..');

export interface AppProcess {
  name: string;
  port: number;
  url: string;
  api: Api;
  proc: Subprocess;
  output: string[];
  exited: Promise<number>;
  /** SIGKILL (hard crash) or SIGTERM (graceful). On Windows both terminate immediately. */
  kill(signal?: 'SIGKILL' | 'SIGTERM'): Promise<number>;
}

/**
 * Starts the application as a separate OS process (`bun run src/main.ts`): the real
 * multi-instance setup — separate memory, separate connection pools, separate consumers.
 */
export async function spawnApp(name: string, env: Env = {}, options: { waitReady?: boolean } = {}): Promise<AppProcess> {
  const port = await freePort();
  const output: string[] = [];
  const proc = Bun.spawn([process.execPath, 'run', 'src/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, ...testEnv(env), PORT: String(port), INSTANCE_ID: name },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) output.push(decoder.decode(chunk));
  };
  void collect(proc.stdout as ReadableStream<Uint8Array>);
  void collect(proc.stderr as ReadableStream<Uint8Array>);

  const url = `http://127.0.0.1:${port}`;
  const handle: AppProcess = {
    name,
    port,
    url,
    api: new Api(url),
    proc,
    output,
    exited: proc.exited,
    async kill(signal = 'SIGKILL') {
      proc.kill(signal);
      return proc.exited;
    },
  };

  if (options.waitReady !== false) {
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (proc.exitCode !== null) {
        throw new Error(`${name} exited with ${proc.exitCode} during startup:\n${output.join('')}`);
      }
      try {
        const response = await fetch(`${url}/health/ready`);
        if (response.status === 200) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) {
        proc.kill('SIGKILL');
        throw new Error(`${name} not ready in time:\n${output.join('')}`);
      }
      await sleep(200);
    }
  }
  return handle;
}

export async function killAll(processes: AppProcess[]): Promise<void> {
  await Promise.all(processes.map((p) => (p.proc.exitCode === null ? p.kill('SIGKILL') : Promise.resolve(0))));
}
