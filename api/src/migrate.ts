import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';

export interface Migration {
  version: string;
  name: string;
  upPath: string;
  downPath: string | null;
}

export interface Logger {
  info(obj: object, msg: string): void;
}

const LOCK_NAME = 'dominion_migrate';
const LOCK_TIMEOUT_SECONDS = 60;
const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;

/**
 * Migrations live in files named `NNNN_description.up.sql` with an optional
 * `NNNN_description.down.sql` used for rollback.
 */
export async function listMigrations(dir: string): Promise<Migration[]> {
  const entries = await readdir(dir);
  const byVersion = new Map<string, Migration>();

  for (const entry of entries.sort()) {
    if (entry === 'README.md' || entry.startsWith('.')) {
      continue;
    }
    const match = FILE_PATTERN.exec(entry);
    if (!match) {
      throw new Error(`Unrecognised file in migrations directory: ${entry}`);
    }
    const [, version, name, direction] = match as unknown as [string, string, string, string];
    const existing = byVersion.get(version);
    if (existing && existing.name !== name) {
      throw new Error(`Migration version ${version} is used by more than one name`);
    }
    const migration: Migration = existing ?? { version, name, upPath: '', downPath: null };
    if (direction === 'up') {
      migration.upPath = path.join(dir, entry);
    } else {
      migration.downPath = path.join(dir, entry);
    }
    byVersion.set(version, migration);
  }

  const migrations = [...byVersion.values()].sort((a, b) => a.version.localeCompare(b.version));
  for (const migration of migrations) {
    if (!migration.upPath) {
      throw new Error(`Migration ${migration.version}_${migration.name} has no .up.sql file`);
    }
  }
  return migrations;
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

async function withLock<T>(pool: mysql.Pool, fn: (conn: mysql.PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query<mysql.RowDataPacket[]>('SELECT GET_LOCK(?, ?) AS acquired', [
      LOCK_NAME,
      LOCK_TIMEOUT_SECONDS,
    ]);
    if (rows[0]?.['acquired'] !== 1) {
      throw new Error('Could not acquire migration lock; another migration may be running');
    }
    try {
      return await fn(conn);
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
    }
  } finally {
    conn.release();
  }
}

async function ensureTrackingTable(conn: mysql.PoolConnection): Promise<void> {
  await conn.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version VARCHAR(4) NOT NULL PRIMARY KEY,
       name VARCHAR(255) NOT NULL,
       checksum CHAR(64) NOT NULL,
       applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );
}

/**
 * Applies every pending migration in version order. Safe to run repeatedly and
 * from several processes at once. Refuses to continue if an already applied
 * migration file has been modified. Returns the versions applied.
 *
 * The pool must be created with `multipleStatements: true`.
 */
export async function applyMigrations(pool: mysql.Pool, dir: string, log: Logger): Promise<string[]> {
  const migrations = await listMigrations(dir);
  return withLock(pool, async (conn) => {
    await ensureTrackingTable(conn);
    const [rows] = await conn.query<mysql.RowDataPacket[]>('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [String(r['version']), String(r['checksum'])]));
    const done: string[] = [];

    for (const migration of migrations) {
      const sql = await readFile(migration.upPath, 'utf8');
      const sum = checksum(sql);
      const recorded = applied.get(migration.version);
      if (recorded !== undefined) {
        if (recorded !== sum) {
          throw new Error(`Applied migration ${migration.version}_${migration.name} was modified after being applied`);
        }
        continue;
      }
      log.info({ version: migration.version, name: migration.name }, 'applying migration');
      await conn.query(sql);
      await conn.query('INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        sum,
      ]);
      done.push(migration.version);
    }
    return done;
  });
}

/** Rolls back the most recently applied migration using its .down.sql file. */
export async function rollbackLast(pool: mysql.Pool, dir: string, log: Logger): Promise<string | null> {
  const migrations = await listMigrations(dir);
  return withLock(pool, async (conn) => {
    await ensureTrackingTable(conn);
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
    );
    const last = rows[0]?.['version'];
    if (last === undefined) {
      return null;
    }
    const migration = migrations.find((m) => m.version === String(last));
    if (!migration?.downPath) {
      throw new Error(`Migration ${String(last)} has no .down.sql file; cannot roll back`);
    }
    log.info({ version: migration.version, name: migration.name }, 'rolling back migration');
    await conn.query(await readFile(migration.downPath, 'utf8'));
    await conn.query('DELETE FROM schema_migrations WHERE version = ?', [migration.version]);
    return migration.version;
  });
}
