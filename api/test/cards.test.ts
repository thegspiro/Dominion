import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadDataset, type Dataset } from '../src/cards/dataset.js';
import { importDataset } from '../src/cards/importer.js';
import { applyMigrations, rollbackLast } from '../src/migrate.js';

const dbHost = process.env['TEST_DB_HOST'];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const silent = { info: () => undefined };
const SETUP_TOKEN = 'test-setup-token-1234';

describe.skipIf(!dbHost)('card import and API against MySQL', () => {
  let pool: mysql.Pool;
  let app: FastifyInstance;
  let dataset: Dataset;
  let cookie = '';

  const count = async (table: string): Promise<number> => {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table}`);
    return Number(rows[0]?.['n']);
  };

  const get = (url: string) => app.inject({ url, headers: { cookie } });

  beforeAll(async () => {
    pool = mysql.createPool({
      host: dbHost,
      port: Number(process.env['TEST_DB_PORT'] ?? 3306),
      user: process.env['TEST_DB_USER'],
      password: process.env['TEST_DB_PASSWORD'],
      database: process.env['TEST_DB_NAME'] ?? 'dominion_test',
      multipleStatements: true,
    });
    await pool.query('DROP TABLE IF EXISTS edition_cards, card_types, cards, editions, invites, sessions, users, schema_migrations');
    await applyMigrations(pool, path.join(root, 'db/migrations'), silent);
    dataset = await loadDataset(path.join(root, 'db/data'));
    await importDataset(pool, dataset, silent);

    app = buildApp(
      { pool, simUrl: 'http://sim', auth: { pool, setupToken: SETUP_TOKEN, cookieSecure: true } },
      false,
    );
    const setup = await app.inject({
      method: 'POST',
      url: '/auth/setup',
      payload: { setupToken: SETUP_TOKEN, username: 'admin', password: 'correct horse battery' },
    });
    cookie = String(setup.headers['set-cookie']).split(';')[0] ?? '';
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('import', () => {
    it('loads every edition, card, type and edition link', async () => {
      expect(await count('editions')).toBe(24);
      expect(await count('cards')).toBe(852);
      expect(await count('card_types')).toBe(dataset.cards.reduce((n, c) => n + c.types.length, 0));
      expect(await count('edition_cards')).toBe(dataset.editions.reduce((n, e) => n + e.cardIds.length, 0));
    });

    it('stores the corrected types and parsed costs', async () => {
      const [types] = await pool.query<mysql.RowDataPacket[]>(
        "SELECT t.type FROM card_types t JOIN cards c ON c.id = t.card_id WHERE c.name_en = 'Ambassador' ORDER BY t.type",
      );
      expect(types.map((r) => r['type'])).toEqual(['Action', 'Attack']);
      const [cost] = await pool.query<mysql.RowDataPacket[]>(
        "SELECT price, cost_coins, cost_potions, cost_debt, cost_variable FROM cards WHERE name_en = 'Peddler'",
      );
      expect(cost[0]).toMatchObject({ price: '8*', cost_coins: 8, cost_potions: 0, cost_debt: 0, cost_variable: 1 });
    });

    it('is idempotent and safe to run concurrently', async () => {
      const results = await Promise.all([importDataset(pool, dataset, silent), importDataset(pool, dataset, silent)]);
      expect(results.map((r) => r.cardsNotInDataset)).toEqual([0, 0]);
      expect(await count('cards')).toBe(852);
      expect(await count('edition_cards')).toBe(dataset.editions.reduce((n, e) => n + e.cardIds.length, 0));
    });

    it('keeps cards that are no longer in the dataset and reports them', async () => {
      await pool.query(
        "INSERT INTO cards (id, name_en, name_de, price, kingdom) VALUES ('11111111-1111-4111-8111-111111111111', 'Retired', 'Ausgemustert', '1', 1)",
      );
      const stats = await importDataset(pool, dataset, silent);
      expect(stats.cardsNotInDataset).toBe(1);
      expect(await count('cards')).toBe(853);
      await pool.query("DELETE FROM cards WHERE name_en = 'Retired'");
    });

    it('rolls back completely when the import fails part way', async () => {
      const before = await count('card_types');
      const broken: Dataset = {
        ...dataset,
        cards: dataset.cards.map((c, i) => (i === 0 ? { ...c, types: ['x'.repeat(40)] } : c)),
      };
      await expect(importDataset(pool, broken, silent)).rejects.toThrow();
      expect(await count('card_types')).toBe(before);
      expect(await count('cards')).toBe(852);
    });
  });

  describe('migration rollback', () => {
    it('drops the card tables with the down migration and restores them on re-apply', async () => {
      expect(await rollbackLast(pool, path.join(root, 'db/migrations'), silent)).toBe('0002');
      const [gone] = await pool.query<mysql.RowDataPacket[]>("SHOW TABLES LIKE 'cards'");
      expect(gone).toHaveLength(0);
      await applyMigrations(pool, path.join(root, 'db/migrations'), silent);
      await importDataset(pool, dataset, silent);
      expect(await count('cards')).toBe(852);
    });
  });

  describe('API', () => {
    it('requires a signed-in user', async () => {
      for (const url of ['/cards', '/editions', '/card-types', '/cards/11111111-1111-4111-8111-111111111111']) {
        expect((await app.inject(url)).statusCode).toBe(401);
      }
    });

    it('lists cards with pagination, sorted by name', async () => {
      const first = (await get('/cards?limit=5')).json();
      expect(first.total).toBe(852);
      expect(first.items).toHaveLength(5);
      const second = (await get('/cards?limit=5&offset=5')).json();
      const names = [...first.items, ...second.items].map((c: { name: { en: string } }) => c.name.en);
      expect(new Set(names).size).toBe(10);
      expect(names.slice(0, 5)).toEqual([...names.slice(0, 5)].sort((a, b) => a.localeCompare(b)));
      expect((await get('/cards')).json().items).toHaveLength(50);
    });

    it('describes a card with cost, types and editions', async () => {
      const village = (await get('/cards?q=Village&type=Action&limit=200')).json().items.find(
        (c: { name: { en: string } }) => c.name.en === 'Village',
      );
      expect(village.cost).toEqual({ price: '3', coins: 3, potions: 0, debt: 0, variable: false });
      expect(village.types).toEqual(['Action']);
      expect(village.editions.length).toBeGreaterThan(0);
      expect(village.kingdom).toBe(true);
    });

    it('searches English and German names, case-insensitively', async () => {
      const en = (await get('/cards?q=vILLAGE')).json();
      expect(en.items.some((c: { name: { en: string } }) => c.name.en === 'Village')).toBe(true);
      const de = (await get('/cards?q=Keller')).json();
      expect(de.items.some((c: { name: { en: string } }) => c.name.en === 'Cellar')).toBe(true);
    });

    it('treats wildcards and SQL in the search text literally', async () => {
      expect((await get('/cards?q=%25')).json().total).toBe(0);
      expect((await get('/cards?q=_')).json().total).toBe(0);
      const injection = await get(`/cards?q=${encodeURIComponent("x' OR '1'='1")}`);
      expect(injection.statusCode).toBe(200);
      expect(injection.json().total).toBe(0);
      expect(await count('cards')).toBe(852);
    });

    it('filters by type, including the corrected Ambassador and Island', async () => {
      const attacks = (await get('/cards?type=Attack&limit=200')).json();
      expect(attacks.items.every((c: { types: string[] }) => c.types.includes('Attack'))).toBe(true);
      expect(attacks.items.some((c: { name: { en: string } }) => c.name.en === 'Ambassador')).toBe(true);
      const victory = (await get('/cards?type=Victory&q=Island')).json();
      expect(victory.items[0].types).toEqual(['Action', 'Victory']);
    });

    it('filters by edition and matches the edition card counts', async () => {
      const editions = (await get('/editions')).json().editions;
      expect(editions).toHaveLength(24);
      expect(editions[editions.length - 1].releaseDate).toBe('various');
      for (const edition of editions.slice(0, 3)) {
        const res = (await get(`/cards?edition=${edition.id}&limit=1`)).json();
        expect(res.total).toBe(edition.cardCount);
      }
    });

    it('filters by cost, potion and kingdom', async () => {
      const cheap = (await get('/cards?minCost=2&maxCost=3&limit=200')).json();
      expect(cheap.total).toBeGreaterThan(0);
      expect(cheap.items.every((c: { cost: { coins: number } }) => c.cost.coins >= 2 && c.cost.coins <= 3)).toBe(true);
      const potions = (await get('/cards?potion=true&limit=200')).json();
      expect(potions.items.every((c: { cost: { potions: number } }) => c.cost.potions > 0)).toBe(true);
      const nonSupply = (await get('/cards?kingdom=false&limit=200')).json();
      expect(nonSupply.total).toBeGreaterThan(0);
      expect(nonSupply.items.every((c: { kingdom: boolean }) => !c.kingdom)).toBe(true);
    });

    it('lists the card types', async () => {
      const types = (await get('/card-types')).json().types as string[];
      expect(types).toContain('Attack');
      expect(types).toEqual([...types].sort());
    });

    it('returns one card by id and 404 for an unknown id', async () => {
      const [card] = (await get('/cards?q=Smithy&limit=1')).json().items;
      const detail = await get(`/cards/${card.id}`);
      expect(detail.statusCode).toBe(200);
      expect(detail.json().name.en).toBe('Smithy');
      const missing = await get('/cards/11111111-1111-4111-8111-111111111111');
      expect(missing.statusCode).toBe(404);
    });

    it('rejects invalid parameters', async () => {
      for (const url of [
        '/cards?limit=0',
        '/cards?limit=201',
        '/cards?offset=-1',
        '/cards?edition=not-a-uuid',
        '/cards?minCost=abc',
        '/cards?potion=maybe',
        '/cards?nonsense=1',
        '/cards/not-a-uuid',
      ]) {
        expect((await get(url)).statusCode, url).toBe(400);
      }
    });
  });
});
