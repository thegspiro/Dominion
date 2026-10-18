import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadDataset } from '../src/cards/dataset.js';
import { importDataset } from '../src/cards/importer.js';
import { loadRules } from '../src/games/rules.js';
import { applyMigrations } from '../src/migrate.js';
import { resetDatabase } from './helpers/db.js';

const dbHost = process.env['TEST_DB_HOST'];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const silent = { info: () => undefined };
const SETUP_TOKEN = 'test-setup-token-1234';
const PASSWORD = 'correct horse battery';
const MISSING_ID = '11111111-1111-4111-8111-111111111111';

interface Session {
  cookie: string;
  csrf: string;
}

interface CardItem {
  id: string;
  name: { en: string };
  types: string[];
  cost: { coins: number | null };
}

describe.skipIf(!dbHost)('kingdom setup against MySQL', () => {
  let pool: mysql.Pool;
  let app: FastifyInstance;
  let owner: Session;
  let other: Session;
  let alchemy = '';
  const ids = new Map<string, string>();

  const call = (session: Session | null, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      payload: payload as object | undefined,
      headers: session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {},
    });

  const draw = (body: object = {}, session = owner) => call(session, 'POST', '/kingdoms/draw', body);
  const items = (res: { json: () => unknown }): CardItem[] => (res.json() as { items: CardItem[] }).items;
  const id = (name: string): string => {
    const found = ids.get(name);
    if (!found) {
      throw new Error(`no card ${name}`);
    }
    return found;
  };
  const prefer = (name: string, preference: 'ban' | 'require' | null, session = owner) =>
    call(session, 'PUT', `/card-preferences/${id(name)}`, { preference });

  async function clearUserData(): Promise<void> {
    await pool.query('DELETE FROM card_preferences; DELETE FROM kingdoms');
  }

  const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0] ?? '';

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
    await applyMigrations(pool, path.join(root, 'db/migrations'), silent);
    await importDataset(pool, await loadDataset(path.join(root, 'db/data')), silent);
    const rules = await loadRules(path.join(root, 'db/data'));
    app = buildApp({ pool, simUrl: 'http://sim', rules, auth: { pool, setupToken: SETUP_TOKEN, cookieSecure: true } }, false);

    const setup = await app.inject({
      method: 'POST',
      url: '/auth/setup',
      payload: { setupToken: SETUP_TOKEN, username: 'admin', password: PASSWORD },
    });
    owner = { cookie: cookieOf(setup), csrf: setup.json().csrfToken };
    const invite = await call(owner, 'POST', '/auth/invites');
    const redeem = await app.inject({
      method: 'POST',
      url: '/auth/invites/redeem',
      payload: { token: invite.json().token, username: 'friend', password: PASSWORD },
    });
    other = { cookie: cookieOf(redeem), csrf: redeem.json().csrfToken };

    const [cards] = await pool.query<mysql.RowDataPacket[]>('SELECT id, name_en FROM cards');
    for (const c of cards) {
      ids.set(String(c['name_en']), String(c['id']));
    }
    const editions = (await call(owner, 'GET', '/editions')).json().editions as { id: string; name: { en: string } }[];
    alchemy = editions.find((e) => e.name.en === 'Alchemy')?.id ?? '';
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('draw', () => {
    it('returns ten distinct kingdom cards, cheapest first', async () => {
      const res = await draw();
      expect(res.statusCode).toBe(200);
      const cards = items(res);
      expect(cards).toHaveLength(10);
      expect(new Set(cards.map((c) => c.name.en)).size).toBe(10);
      const costs = cards.map((c) => c.cost.coins ?? 0);
      expect(costs).toEqual([...costs].sort((a, b) => a - b));
      const names = new Set(cards.map((c) => c.name.en));
      for (const banned of ['Potion', 'Platinum', 'Colony', 'Copper', 'Province']) {
        expect(names.has(banned)).toBe(false);
      }
    });

    it('honours the edition, count, cost and type filters', async () => {
      const inAlchemy = items(await draw({ editions: [alchemy] }));
      expect(inAlchemy).toHaveLength(10);
      const alchemyCards = (await call(owner, 'GET', `/cards?edition=${alchemy}&limit=50`)).json().items as CardItem[];
      const alchemyNames = new Set(alchemyCards.map((c) => c.name.en));
      expect(inAlchemy.every((c) => alchemyNames.has(c.name.en))).toBe(true);

      expect(items(await draw({ count: 4 }))).toHaveLength(4);

      const mid = items(await draw({ minCost: 3, maxCost: 4 }));
      expect(mid.every((c) => (c.cost.coins ?? -1) >= 3 && (c.cost.coins ?? 99) <= 4)).toBe(true);

      for (let i = 0; i < 8; i += 1) {
        const calm = items(await draw({ excludeTypes: ['Attack', 'Duration'] }));
        expect(calm.some((c) => c.types.includes('Attack') || c.types.includes('Duration'))).toBe(false);
      }
    });

    it('explains why a draw cannot be made', async () => {
      const reason = async (body: object) => {
        const res = await draw(body);
        expect(res.statusCode).toBe(422);
        return res.json().reason;
      };
      expect(await reason({ minCost: 5, maxCost: 2 })).toBe('invalid_cost_range');
      expect(await reason({ editions: [alchemy], minCost: 7 })).toBe('not_enough_cards');
      expect(await reason({ lockedIds: [id('Delve')] })).toBe('not_a_supply_card');
      expect(await reason({ lockedIds: [MISSING_ID] })).toBe('not_a_supply_card');
    });

    it('keeps locked cards and replaces the rest', async () => {
      const first = items(await draw());
      const locked = first.slice(0, 3).map((c) => c.id);
      for (let i = 0; i < 12; i += 1) {
        const res = await draw({ lockedIds: locked });
        const cards = items(res);
        expect(cards).toHaveLength(10);
        for (const lockId of locked) {
          expect(cards.some((c) => c.id === lockId)).toBe(true);
        }
        expect((res.json() as { fixedIds: string[] }).fixedIds.sort()).toEqual([...locked].sort());
      }
    });

    it('rejects more fixed cards than the kingdom holds', async () => {
      const ten = items(await draw());
      const spare = ['Possession', 'Alchemist', 'Village', 'Smithy'].find((name) => !ten.some((c) => c.name.en === name)) as string;
      expect((await prefer(spare, 'require')).statusCode).toBe(200);
      const res = await draw({ lockedIds: ten.map((c) => c.id) });
      expect([res.statusCode, res.json().reason]).toEqual([422, 'too_many_fixed']);
      await clearUserData();
    });

    it('validates the request shape', async () => {
      for (const body of [
        { count: 0 },
        { count: 11 },
        { editions: ['nope'] },
        { minCost: -1 },
        { lockedIds: new Array(11).fill(MISSING_ID) },
        { excludeTypes: [''] },
        { surprise: true },
      ]) {
        expect((await draw(body)).statusCode, JSON.stringify(body)).toBe(400);
      }
      expect((await call(null, 'POST', '/kingdoms/draw', {})).statusCode).toBe(401);
      const noCsrf = await app.inject({ method: 'POST', url: '/kingdoms/draw', headers: { cookie: owner.cookie }, payload: {} });
      expect(noCsrf.statusCode).toBe(403);
    });
  });

  describe('never-draw and always-include lists', () => {
    it('applies bans to every draw', async () => {
      expect((await prefer('Alchemist', 'ban')).statusCode).toBe(200);
      for (let i = 0; i < 20; i += 1) {
        expect(items(await draw({ editions: [alchemy] })).some((c) => c.name.en === 'Alchemist')).toBe(false);
      }
      await clearUserData();
    });

    it('applies requires to every draw, even when the filters would exclude the card', async () => {
      expect((await prefer('Possession', 'require')).statusCode).toBe(200);
      for (let i = 0; i < 15; i += 1) {
        expect(items(await draw()).some((c) => c.name.en === 'Possession')).toBe(true);
      }
      const cheap = await draw({ maxCost: 2 });
      expect(items(cheap).some((c) => c.name.en === 'Possession')).toBe(true);
      await clearUserData();
    });

    it('lists, switches, and removes preferences, one per card', async () => {
      let res = await prefer('Witch', 'ban');
      expect(res.json().preferences).toEqual([{ id: id('Witch'), name: { en: 'Witch' }, preference: 'ban' }]);
      res = await prefer('Witch', 'require');
      expect(res.json().preferences).toEqual([{ id: id('Witch'), name: { en: 'Witch' }, preference: 'require' }]);
      await prefer('Cellar', 'ban');
      const listed = (await call(owner, 'GET', '/card-preferences')).json().preferences as { name: { en: string } }[];
      expect(listed.map((p) => p.name.en)).toEqual(['Cellar', 'Witch']);
      res = await prefer('Witch', null);
      expect((res.json().preferences as unknown[]).length).toBe(1);
      await clearUserData();
    });

    it('allows banning any card but only requiring cards a game can use', async () => {
      expect((await prefer('Potion', 'ban')).statusCode).toBe(200);
      expect((await prefer('Delve', 'ban')).statusCode).toBe(200);
      const refused = await prefer('Delve', 'require');
      expect([refused.statusCode, refused.json().reason]).toEqual([422, 'not_a_supply_card']);
      expect((await prefer('Potion', 'require')).statusCode).toBe(422);
      const unknown = await call(owner, 'PUT', `/card-preferences/${MISSING_ID}`, { preference: 'ban' });
      expect(unknown.statusCode).toBe(404);
      await clearUserData();
    });

    it('limits always-include to ten cards without counting a card twice', async () => {
      const pickable = items(await draw({ count: 10 })).map((c) => c.name.en);
      for (const name of pickable) {
        expect((await prefer(name, 'require')).statusCode, name).toBe(200);
      }
      expect((await prefer(pickable[0] as string, 'require')).statusCode).toBe(200);
      const extra = ['Village', 'Smithy', 'Market', 'Militia', 'Moat'].find((name) => !pickable.includes(name)) as string;
      const eleventh = await prefer(extra, 'require');
      expect([eleventh.statusCode, eleventh.json().reason]).toEqual([422, 'too_many_required']);
      expect((await prefer(extra, 'ban')).statusCode).toBe(200);
      await clearUserData();
    });

    it('keeps each account\'s lists private', async () => {
      await prefer('Alchemist', 'ban', owner);
      expect(((await call(other, 'GET', '/card-preferences')).json().preferences as unknown[]).length).toBe(0);
      let seen = false;
      for (let i = 0; i < 25 && !seen; i += 1) {
        seen = items(await draw({ editions: [alchemy] }, other)).some((c) => c.name.en === 'Alchemist');
      }
      expect(seen).toBe(true);
      await clearUserData();
    });

    it('needs sign-in, the CSRF token and a valid value', async () => {
      expect((await call(null, 'GET', '/card-preferences')).statusCode).toBe(401);
      expect((await call(null, 'PUT', `/card-preferences/${id('Witch')}`, { preference: 'ban' })).statusCode).toBe(401);
      const noCsrf = await app.inject({
        method: 'PUT',
        url: `/card-preferences/${id('Witch')}`,
        headers: { cookie: owner.cookie },
        payload: { preference: 'ban' },
      });
      expect(noCsrf.statusCode).toBe(403);
      for (const body of [{ preference: 'maybe' }, {}, { preference: 'ban', extra: 1 }]) {
        expect((await call(owner, 'PUT', `/card-preferences/${id('Witch')}`, body)).statusCode, JSON.stringify(body)).toBe(400);
      }
      expect((await call(owner, 'PUT', '/card-preferences/not-a-uuid', { preference: 'ban' })).statusCode).toBe(400);
    });
  });

  describe('saved kingdoms', () => {
    const save = (name: string, cardIds: string[], session = owner) => call(session, 'POST', '/kingdoms', { name, cardIds });
    const tenIds = async (): Promise<string[]> => items(await draw()).map((c) => c.id);

    it('saves, lists, loads and deletes a kingdom', async () => {
      const cardIds = await tenIds();
      const created = await save('  Friday night  ', cardIds);
      expect(created.statusCode, created.body).toBe(201);
      expect(created.json().name).toBe('Friday night');
      expect((created.json().items as unknown[]).length).toBe(10);
      const kingdomId = created.json().id as string;

      const listed = (await call(owner, 'GET', '/kingdoms')).json().kingdoms as { id: string; name: string; cardNames: string[] }[];
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id: kingdomId, name: 'Friday night' });
      expect(listed[0]?.cardNames).toHaveLength(10);

      const loaded = await call(owner, 'GET', `/kingdoms/${kingdomId}`);
      expect(items(loaded).map((c) => c.id).sort()).toEqual([...cardIds].sort());

      expect((await call(owner, 'DELETE', `/kingdoms/${kingdomId}`)).statusCode).toBe(204);
      expect((await call(owner, 'GET', `/kingdoms/${kingdomId}`)).statusCode).toBe(404);
      const [left] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS n FROM kingdom_cards WHERE kingdom_id = ?', [kingdomId]);
      expect(left[0]?.['n']).toBe(0);
      expect((await call(owner, 'DELETE', `/kingdoms/${kingdomId}`)).statusCode).toBe(404);
    });

    it('refuses duplicate names (ignoring case) and lets exactly one of two simultaneous saves win', async () => {
      await clearUserData();
      const cardIds = await tenIds();
      expect((await save('Mine', cardIds)).statusCode).toBe(201);
      const again = await save('MINE', cardIds);
      expect([again.statusCode, again.json().error]).toEqual([409, 'name_taken']);

      const racing = await Promise.all([save('Race', cardIds), save('Race', cardIds)]);
      expect(racing.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      await clearUserData();
    });

    it('rejects bad names and bad card lists', async () => {
      const cardIds = await tenIds();
      const reason = async (name: string, ids: string[]) => {
        const res = await save(name, ids);
        expect(res.statusCode, `${name} ${ids.length}`).toBe(422);
        return res.json().reason;
      };
      expect(await reason('   ', cardIds)).toBe('invalid_name');
      expect(await reason('bad\u0007name', cardIds)).toBe('invalid_name');
      expect(await reason('dup', [cardIds[0] as string, ...cardIds.slice(0, 9)])).toBe('duplicate_card');
      expect(await reason('potion', [id('Potion'), ...cardIds.slice(1)])).toBe('not_a_supply_card');
      expect(await reason('event', [id('Delve'), ...cardIds.slice(1)])).toBe('not_a_supply_card');
      expect(await reason('ghost', [MISSING_ID, ...cardIds.slice(1)])).toBe('not_a_supply_card');
      expect((await save('short', cardIds.slice(0, 9))).statusCode).toBe(400);
      expect((await save('x'.repeat(61), cardIds)).statusCode).toBe(400);
      expect((await call(owner, 'POST', '/kingdoms', { name: 'extra', cardIds, more: 1 })).statusCode).toBe(400);
    });

    it('keeps kingdoms private to their owner', async () => {
      await clearUserData();
      const created = await save('Secret', await tenIds());
      const kingdomId = created.json().id as string;
      expect(((await call(other, 'GET', '/kingdoms')).json().kingdoms as unknown[]).length).toBe(0);
      expect((await call(other, 'GET', `/kingdoms/${kingdomId}`)).statusCode).toBe(404);
      expect((await call(other, 'DELETE', `/kingdoms/${kingdomId}`)).statusCode).toBe(404);
      expect((await call(owner, 'GET', `/kingdoms/${kingdomId}`)).statusCode).toBe(200);
      expect((await save('Secret', await tenIds(), other)).statusCode).toBe(201);
      await clearUserData();
    });

    it('stops at 200 saved kingdoms per account', async () => {
      await clearUserData();
      const [users] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM users WHERE username = 'admin'");
      const rows = Array.from({ length: 200 }, (_, i) => [`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, users[0]?.['id'], `K${i}`]);
      await pool.query('INSERT INTO kingdoms (id, owner_user_id, name) VALUES ?', [rows]);
      const res = await save('One too many', await tenIds());
      expect([res.statusCode, res.json().reason]).toEqual([422, 'too_many_kingdoms']);
      await clearUserData();
    });

    it('needs sign-in and the CSRF token', async () => {
      expect((await call(null, 'GET', '/kingdoms')).statusCode).toBe(401);
      expect((await call(null, 'POST', '/kingdoms', {})).statusCode).toBe(401);
      expect((await call(null, 'DELETE', `/kingdoms/${MISSING_ID}`)).statusCode).toBe(401);
      const noCsrf = await app.inject({ method: 'DELETE', url: `/kingdoms/${MISSING_ID}`, headers: { cookie: owner.cookie } });
      expect(noCsrf.statusCode).toBe(403);
      expect((await call(owner, 'GET', '/kingdoms/not-a-uuid')).statusCode).toBe(400);
    });
  });
});
