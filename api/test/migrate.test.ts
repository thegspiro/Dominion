import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, listMigrations, rollbackLast } from '../src/migrate.js';

const silent = { info: () => undefined };

async function makeDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'migrations-'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

describe('listMigrations', () => {
  it('orders migrations by version and pairs up/down files', async () => {
    const dir = await makeDir({
      '0002_b.up.sql': 'SELECT 2;',
      '0001_a.up.sql': 'SELECT 1;',
      '0001_a.down.sql': 'SELECT 0;',
      'README.md': 'docs',
    });
    const list = await listMigrations(dir);
    expect(list.map((m) => m.version)).toEqual(['0001', '0002']);
    expect(list[0]?.downPath).toContain('0001_a.down.sql');
    expect(list[1]?.downPath).toBeNull();
    await rm(dir, { recursive: true });
  });

  it('rejects unrecognised files', async () => {
    const dir = await makeDir({ 'bad.sql': 'SELECT 1;' });
    await expect(listMigrations(dir)).rejects.toThrow('Unrecognised file');
    await rm(dir, { recursive: true });
  });

  it('rejects a down file without an up file', async () => {
    const dir = await makeDir({ '0001_a.down.sql': 'SELECT 1;' });
    await expect(listMigrations(dir)).rejects.toThrow('no .up.sql');
    await rm(dir, { recursive: true });
  });
});

const dbHost = process.env['TEST_DB_HOST'];

describe.skipIf(!dbHost)('migrations against MySQL', () => {
  let pool: mysql.Pool;

  beforeAll(() => {
    pool = mysql.createPool({
      host: dbHost,
      port: Number(process.env['TEST_DB_PORT'] ?? 3306),
      user: process.env['TEST_DB_USER'],
      password: process.env['TEST_DB_PASSWORD'],
      database: process.env['TEST_DB_NAME'] ?? 'dominion_test',
      multipleStatements: true,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DROP TABLE IF EXISTS schema_migrations, widget, gadget');
  });

  const files = {
    '0001_widget.up.sql': 'CREATE TABLE widget (id INT PRIMARY KEY);',
    '0001_widget.down.sql': 'DROP TABLE widget;',
    '0002_gadget.up.sql': 'CREATE TABLE gadget (id INT PRIMARY KEY);',
  };

  it('applies pending migrations once and is idempotent', async () => {
    const dir = await makeDir(files);
    expect(await applyMigrations(pool, dir, silent)).toEqual(['0001', '0002']);
    expect(await applyMigrations(pool, dir, silent)).toEqual([]);
    const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT version FROM schema_migrations ORDER BY version');
    expect(rows.map((r) => r['version'])).toEqual(['0001', '0002']);
    await rm(dir, { recursive: true });
  });

  it('is safe when run concurrently', async () => {
    const dir = await makeDir(files);
    const results = await Promise.all([applyMigrations(pool, dir, silent), applyMigrations(pool, dir, silent)]);
    expect(results.flat().sort()).toEqual(['0001', '0002']);
    await rm(dir, { recursive: true });
  });

  it('refuses to run when an applied migration was modified', async () => {
    const dir = await makeDir(files);
    await applyMigrations(pool, dir, silent);
    await writeFile(path.join(dir, '0001_widget.up.sql'), 'CREATE TABLE widget (id BIGINT PRIMARY KEY);');
    await expect(applyMigrations(pool, dir, silent)).rejects.toThrow('modified after being applied');
    await rm(dir, { recursive: true });
  });

  it('rolls back the latest migration using its down file', async () => {
    const dir = await makeDir({
      '0001_widget.up.sql': 'CREATE TABLE widget (id INT PRIMARY KEY);',
      '0001_widget.down.sql': 'DROP TABLE widget;',
    });
    await applyMigrations(pool, dir, silent);
    expect(await rollbackLast(pool, dir, silent)).toBe('0001');
    const [tables] = await pool.query<mysql.RowDataPacket[]>("SHOW TABLES LIKE 'widget'");
    expect(tables).toHaveLength(0);
    expect(await rollbackLast(pool, dir, silent)).toBeNull();
    await rm(dir, { recursive: true });
  });

  it('fails to roll back a migration with no down file', async () => {
    const dir = await makeDir(files);
    await applyMigrations(pool, dir, silent);
    await expect(rollbackLast(pool, dir, silent)).rejects.toThrow('no .down.sql');
    await rm(dir, { recursive: true });
  });
});
