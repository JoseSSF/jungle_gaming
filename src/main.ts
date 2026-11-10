import 'reflect-metadata';
import { createApp } from './bootstrap';
import { loadConfig } from './config/app-config';

async function main(): Promise<void> {
  const config = loadConfig();
  await createApp(config, { shutdownHooks: true });
}

main().catch((error: unknown) => {
  // Logger may not exist yet: emit a minimal structured line.
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', msg: 'application_start_failed', error: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exit(1);
});
