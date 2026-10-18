import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { loadRules } from './games/rules.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.db);
  const app = buildApp({
    pool,
    simUrl: config.simUrl,
    trustProxy: config.trustProxy,
    rules: await loadRules(config.cardsDataDir),
    auth: { pool, setupToken: config.setupToken, cookieSecure: config.cookieSecure },
  });
  if (config.setupToken === undefined) {
    app.log.warn('SETUP_TOKEN is not set; the first-run admin setup is disabled until it is configured');
  }

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
