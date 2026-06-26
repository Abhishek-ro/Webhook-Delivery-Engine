import { claimUnenqueued } from '../db/deliveries.repo.js';
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';

let shuttingDown = false;

async function tick(): Promise<void> {
  try {
    const count = await claimUnenqueued(config.RECONCILER_BATCH_SIZE);
    if (count > 0) {
      logger.info({ count }, 'enqueued orphaned deliveries');
    }
  } catch (err) {
    logger.error({ err }, 'reconciler tick failed');
  }
}

async function loop(): Promise<void> {
  while (!shuttingDown) {
    await tick();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, config.RECONCILER_INTERVAL_MS);
    });
  }
}

process.on('SIGTERM', () => {
  shuttingDown = true;
});

void loop();
