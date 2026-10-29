import mysql from 'mysql2/promise';
import pino from 'pino';
import { loadConfig } from '../config.js';
import { rebuildDecks } from '../games/rebuild.js';

async function main(): Promise<void> {
  const log = pino({ name: 'rebuild-decks' });
  const config = loadConfig();
  const pool = mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.name,
    user: config.db.user,
    password: config.db.password,
    connectionLimit: 2,
    charset: 'utf8mb4',
  });
  try {
    await rebuildDecks(pool, log);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
