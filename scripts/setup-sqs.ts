import { loadConfig } from '../src/config/app-config';
import { createSqsClient, SqsQueues } from '../src/infrastructure/messaging/sqs-queues';

/** Creates wager-transactions.fifo, wager-transactions-dlq.fifo and wagering-events.fifo (idempotent). */
async function main(): Promise<void> {
  const config = loadConfig();
  const queues = new SqsQueues(createSqsClient(config), config.sqs);
  await queues.ensure();
  const urls = {
    main: await queues.url('main'),
    dlq: await queues.url('dlq'),
    events: await queues.url('events'),
  };
  console.log(JSON.stringify({ msg: 'sqs_queues_ready', urls }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
