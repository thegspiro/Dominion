import mysql from 'mysql2/promise';
import pino from 'pino';
import { loadConfig } from '../config.js';
import { loadDataset } from '../cards/dataset.js';
import { importDataset } from '../cards/importer.js';

async function main(): Promise<void> {
  const log = pino({ name: 'import-cards' });
  const config = loadConfig();
  const dataset = await loadDataset(config.cardsDataDir);
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
    await importDataset(pool, dataset, log);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
