import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, rollbackLast } from '../src/migrate.js';
import { resetDatabase } from './helpers/db.js';

const dbHost = process.env['TEST_DB_HOST'];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const migrations = path.join(root, 'db/migrations');
const silent = { info: () => undefined };
const GAME_ID = '22222222-2222-4222-8222-222222222222';

describe.skipIf(!dbHost)('migration 0005_game_cards', () => {
  let pool: mysql.Pool;
  let oldDir: string;

  const columnExists = async (): Promise<boolean> => {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'games' AND column_name = 'cards_source'",
    );
    return Number(rows[0]?.['n']) === 1;
  };

  const tableExists = async (): Promise<boolean> => {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'game_player_cards'",
    );
    return Number(rows[0]?.['n']) === 1;
  };

  beforeAll(async () => {
    pool = mysql.createPool({
      host: dbHost,
      port: Number(process.env['TEST_DB_PORT'] ?? 3306),
      user: process.env['TEST_DB_USER'],
      password: process.env['TEST_DB_PASSWORD'],
      database: process.env['TEST_DB_NAME'] ?? 'dominion_test',
      multipleStatements: true,
    });
    await resetDatabase(pool);
    oldDir = await mkdtemp(path.join(os.tmpdir(), 'dominion-migrations-'));
    for (const file of await readdir(migrations)) {
      if (/^000[1-4]_/.test(file)) {
        await cp(path.join(migrations, file), path.join(oldDir, file));
      }
    }
  });

  afterAll(async () => {
    await rm(oldDir, { recursive: true, force: true });
    await pool.end();
  });

  it('keeps games that already exist and marks them as having no deck data', async () => {
    await applyMigrations(pool, oldDir, silent);
    expect(await tableExists()).toBe(false);
    await pool.query("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'old', 'x', 'admin')");
    await pool.query(
      "INSERT INTO games (id, owner_user_id, status, player_count, notes) VALUES (?, 1, 'finished', 2, '[]')",
      [GAME_ID],
    );
    await pool.query("INSERT INTO game_players (game_id, seat, name, vp, turns_taken) VALUES (?, 0, 'Ann', 5, 3), (?, 1, 'Ben', 2, 3)", [GAME_ID, GAME_ID]);
    await pool.query(
      "INSERT INTO game_piles (game_id, pile_key, label, kind, count, start_count, enforced, position) VALUES (?, 'silver', 'Silver', 'treasure', 40, 40, 1, 0)",
      [GAME_ID],
    );

    const applied = await applyMigrations(pool, migrations, silent);
    expect(applied).toContain('0005');
    expect(await tableExists()).toBe(true);
    expect(await columnExists()).toBe(true);

    const [games] = await pool.query<RowDataPacket[]>('SELECT status, cards_source FROM games WHERE id = ?', [GAME_ID]);
    expect(games[0]).toMatchObject({ status: 'finished', cards_source: 'none' });
    const [players] = await pool.query<RowDataPacket[]>('SELECT name, vp FROM game_players WHERE game_id = ? ORDER BY seat', [GAME_ID]);
    expect(players.map((p) => [p['name'], p['vp']])).toEqual([['Ann', 5], ['Ben', 2]]);
  });

  it('marks games created afterwards as tracked', async () => {
    const other = '33333333-3333-4333-8333-333333333333';
    await pool.query("INSERT INTO games (id, owner_user_id, player_count, notes) VALUES (?, 1, 2, '[]')", [other]);
    const [rows] = await pool.query<RowDataPacket[]>('SELECT cards_source FROM games WHERE id = ?', [other]);
    expect(rows[0]?.['cards_source']).toBe('tracked');
    await pool.query('DELETE FROM games WHERE id = ?', [other]);
  });

  it('deletes deck rows with their game and refuses rows for a pile the game does not have', async () => {
    await pool.query("INSERT INTO game_player_cards (game_id, seat, pile_key, count) VALUES (?, 0, 'silver', 2)", [GAME_ID]);
    await expect(
      pool.query("INSERT INTO game_player_cards (game_id, seat, pile_key, count) VALUES (?, 0, 'nope', 1)", [GAME_ID]),
    ).rejects.toThrow();
    await pool.query('DELETE FROM game_piles WHERE game_id = ? AND pile_key = ?', [GAME_ID, 'silver']);
    const [rows] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM game_player_cards WHERE game_id = ?', [GAME_ID]);
    expect(Number(rows[0]?.['n'])).toBe(0);
  });

  it('rolls back cleanly, keeps the games, and applies again', async () => {
    expect(await rollbackLast(pool, migrations, silent)).toBe('0005');
    expect(await tableExists()).toBe(false);
    expect(await columnExists()).toBe(false);
    const [games] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM games');
    expect(Number(games[0]?.['n'])).toBe(1);

    await applyMigrations(pool, migrations, silent);
    expect(await tableExists()).toBe(true);
    const [rows] = await pool.query<RowDataPacket[]>('SELECT cards_source FROM games WHERE id = ?', [GAME_ID]);
    expect(rows[0]?.['cards_source']).toBe('none');
  });

  it('is safe to run the up script a second time by hand', async () => {
    const fs = await import('node:fs/promises');
    const sql = await fs.readFile(path.join(migrations, '0005_game_cards.up.sql'), 'utf8');
    await pool.query(sql);
    expect(await columnExists()).toBe(true);
    const [rows] = await pool.query<RowDataPacket[]>('SELECT cards_source FROM games WHERE id = ?', [GAME_ID]);
    expect(rows[0]?.['cards_source']).toBe('none');
  });
});
