import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.db);
  const app = buildApp({ pool, simUrl: config.simUrl });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
