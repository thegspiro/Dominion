import mysql from 'mysql2/promise';
import pino from 'pino';
import { loadConfig } from '../config.js';
import { applyMigrations, rollbackLast } from '../migrate.js';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  if (command !== 'up' && command !== 'down') {
    throw new Error(`Unknown command "${command}"; use "up" or "down"`);
  }

  const log = pino({ name: 'migrate' });
  const config = loadConfig();
  const pool = mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.name,
    user: config.db.user,
    password: config.db.password,
    multipleStatements: true,
    connectionLimit: 2,
    charset: 'utf8mb4',
  });

  try {
    if (command === 'up') {
      const applied = await applyMigrations(pool, config.migrationsDir, log);
      log.info({ applied }, 'migrations complete');
    } else {
      const reverted = await rollbackLast(pool, config.migrationsDir, log);
      log.info({ reverted }, 'rollback complete');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
