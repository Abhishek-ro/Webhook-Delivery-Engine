import { buildApp } from './app.js';
import { config } from '../shared/config.js';
import { redis } from '../redis/client.js';

const app = buildApp();

const start = async () => {
  try {
    await redis.connect();
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void start();
