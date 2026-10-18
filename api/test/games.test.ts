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

interface Session {
  cookie: string;
  csrf: string;
}

interface Pile {
  key: string;
  count: number;
  enforced: boolean;
  label: string;
}

describe.skipIf(!dbHost)('game tracker against MySQL', () => {
  let pool: mysql.Pool;
  let app: FastifyInstance;
  let owner: Session;
  let other: Session;
  let kingdomIds: string[] = [];

  const call = (session: Session | null, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      payload: payload as object | undefined,
      headers: session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {},
    });

  const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0] ?? '';

  const newGame = async (session = owner, players = ['Ann', 'Ben']) => {
    const res = await call(session, 'POST', '/games', { players: players.map((name) => ({ name })), cardIds: kingdomIds });
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  };

  const act = (session: Session, game: { id: string; version: number }, action: object, version = game.version) =>
    call(session, 'POST', `/games/${game.id}/actions`, { expectedVersion: version, action });

  const pile = (game: { piles: Pile[] }, key: string): Pile => {
    const found = game.piles.find((p) => p.key === key);
    if (!found) {
      throw new Error(`no pile ${key}`);
    }
    return found;
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
    await applyMigrations(pool, path.join(root, 'db/migrations'), silent);
    await importDataset(pool, await loadDataset(path.join(root, 'db/data')), silent);
    const rules = await loadRules(path.join(root, 'db/data'));

    app = buildApp(
      { pool, simUrl: 'http://sim', rules, auth: { pool, setupToken: SETUP_TOKEN, cookieSecure: true } },
      false,
    );
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

    const random = await call(owner, 'GET', '/kingdoms/random');
    kingdomIds = random.json().items.map((c: { id: string }) => c.id);
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('random kingdom', () => {
    it('returns ten distinct cards that can be supply piles', async () => {
      const res = await call(owner, 'GET', '/kingdoms/random');
      const items = res.json().items as { name: { en: string }; types: string[]; cost: { coins: number | null } }[];
      expect(items).toHaveLength(10);
      expect(new Set(items.map((c) => c.name.en)).size).toBe(10);
      const banned = ['Event', 'Landmark', 'Project', 'Way', 'Knight', 'Castle', 'Ruins', 'Looter', 'Spirit'];
      for (const item of items) {
        expect(item.cost.coins).not.toBeNull();
        expect(item.types.some((t) => banned.includes(t))).toBe(false);
      }
    });

    it('honours the edition filter and the count', async () => {
      const editions = (await call(owner, 'GET', '/editions')).json().editions as { id: string; name: { en: string } }[];
      const base2 = editions.find((e) => e.name.en === 'Base (2nd Edition)');
      const res = await call(owner, 'GET', `/kingdoms/random?edition=${base2?.id}&count=5`);
      const items = res.json().items as { editions: { id: string }[] }[];
      expect(items).toHaveLength(5);
      expect(items.every((c) => c.editions.some((e) => e.id === base2?.id))).toBe(true);
    });

    it('varies between draws and needs a signed-in user', async () => {
      const draws = new Set<string>();
      for (let i = 0; i < 6; i += 1) {
        draws.add(((await call(owner, 'GET', '/kingdoms/random')).json().items as { id: string }[]).map((c) => c.id).sort().join());
      }
      expect(draws.size).toBeGreaterThan(1);
      expect((await call(null, 'GET', '/kingdoms/random')).statusCode).toBe(401);
      expect((await call(owner, 'GET', '/kingdoms/random?count=11')).statusCode).toBe(400);
    });
  });

  describe('creating a game', () => {
    it('creates a two-player game with the correct piles', async () => {
      const game = await newGame();
      expect(game).toMatchObject({ status: 'active', playerCount: 2, turnNumber: 1, currentSeat: 0, version: 1 });
      expect(game.resources).toEqual({ actions: 1, buys: 1, coins: 0 });
      expect(pile(game, 'copper').count).toBe(46);
      expect(pile(game, 'province').count).toBe(8);
      expect(pile(game, 'curse').count).toBe(10);
      expect((game.piles as Pile[]).filter((p) => p.key.startsWith('card:'))).toHaveLength(10);
      expect(game.players.map((p: { name: string }) => p.name)).toEqual(['Ann', 'Ben']);
      expect(game.canUndo).toBe(false);
    });

    it('sizes the piles for four players and adds Platinum and Colony on request', async () => {
      const res = await call(owner, 'POST', '/games', {
        players: ['A', 'B', 'C', 'D'].map((name) => ({ name })),
        cardIds: kingdomIds,
        prosperityPiles: true,
      });
      const game = res.json();
      expect(pile(game, 'copper').count).toBe(32);
      expect(pile(game, 'province').count).toBe(12);
      expect(pile(game, 'curse').count).toBe(30);
      expect(pile(game, 'colony').count).toBe(12);
      expect(pile(game, 'platinum').count).toBe(12);
    });

    it('marks Knights as a hand-counted pile and says so', async () => {
      const [rows] = await pool.query<mysql.RowDataPacket[]>(
        "SELECT c.id FROM cards c JOIN card_types t ON t.card_id = c.id WHERE t.type = 'Knight' AND c.kingdom = 1 AND c.cost_coins IS NOT NULL LIMIT 1",
      );
      const knightId = String(rows[0]?.['id']);
      const res = await call(owner, 'POST', '/games', {
        players: [{ name: 'A' }, { name: 'B' }],
        cardIds: [knightId, ...kingdomIds.slice(1)],
      });
      expect(res.statusCode, res.body).toBe(201);
      const game = res.json();
      expect(pile(game, `card:${knightId}`).enforced).toBe(false);
      expect(game.notes.join(' ')).toContain('counted by hand');
    });

    it('refuses cards that are not supply cards', async () => {
      const [rows] = await pool.query<mysql.RowDataPacket[]>(
        "SELECT c.id FROM cards c JOIN card_types t ON t.card_id = c.id WHERE t.type IN ('Way','Trait','Ally','Prophecy','Spirit') AND c.kingdom = 1 AND c.cost_coins IS NOT NULL LIMIT 1",
      );
      expect(rows.length).toBeGreaterThan(0);
      const res = await call(owner, 'POST', '/games', {
        players: [{ name: 'A' }, { name: 'B' }],
        cardIds: [String(rows[0]?.['id']), ...kingdomIds.slice(1)],
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({ error: 'invalid_game', reason: 'not_a_supply_card' });
    });

    it('refuses the basic Potion, Platinum and Colony cards as kingdom cards', async () => {
      const [rows] = await pool.query<mysql.RowDataPacket[]>(
        "SELECT id, name_en FROM cards WHERE name_en IN ('Potion', 'Platinum', 'Colony')",
      );
      expect(rows.map((r) => r['name_en']).sort()).toEqual(['Colony', 'Platinum', 'Potion']);
      for (const row of rows) {
        const res = await call(owner, 'POST', '/games', {
          players: [{ name: 'A' }, { name: 'B' }],
          cardIds: [String(row['id']), ...kingdomIds.slice(1)],
        });
        expect(res.statusCode, String(row['name_en'])).toBe(422);
        expect(res.json().reason).toBe('not_a_supply_card');
      }
    });

    it('never offers them in a random kingdom', async () => {
      const [rows] = await pool.query<mysql.RowDataPacket[]>(
        "SELECT id FROM cards WHERE name_en IN ('Potion', 'Platinum', 'Colony')",
      );
      const banned = new Set(rows.map((r) => String(r['id'])));
      for (let i = 0; i < 25; i += 1) {
        const ids = ((await call(owner, 'GET', '/kingdoms/random')).json().items as { id: string }[]).map((c) => c.id);
        expect(ids.some((id) => banned.has(id))).toBe(false);
      }
    });

    it('validates the request', async () => {
      const players = [{ name: 'A' }, { name: 'B' }];
      const status = async (body: unknown) => (await call(owner, 'POST', '/games', body)).statusCode;
      expect(await status({ players: [{ name: 'A' }], cardIds: kingdomIds })).toBe(400);
      expect(await status({ players: [...players, ...players, ...players], cardIds: kingdomIds })).toBe(400);
      expect(await status({ players, cardIds: kingdomIds.slice(0, 9) })).toBe(400);
      expect(await status({ players, cardIds: ['nope', ...kingdomIds.slice(1)] })).toBe(400);
      expect(await status({ players, cardIds: kingdomIds, extra: true })).toBe(400);
      expect(await status({ players: [{ name: 'A' }, { name: 'a' }], cardIds: kingdomIds })).toBe(422);
      expect(await status({ players, cardIds: [...kingdomIds.slice(1), '11111111-1111-4111-8111-111111111111'] })).toBe(422);
      expect(await status({ players, cardIds: [kingdomIds[0], ...kingdomIds.slice(0, 9)] })).toBe(422);
    });

    it('requires sign-in and the CSRF token', async () => {
      expect((await call(null, 'POST', '/games', {})).statusCode).toBe(401);
      const noCsrf = await app.inject({
        method: 'POST',
        url: '/games',
        headers: { cookie: owner.cookie },
        payload: { players: [{ name: 'A' }, { name: 'B' }], cardIds: kingdomIds },
      });
      expect(noCsrf.statusCode).toBe(403);
    });
  });

  describe('actions', () => {
    it('applies each action and bumps the version once per change', async () => {
      let game = await newGame();
      game = (await act(owner, game, { type: 'take', pileKey: 'gold', quantity: 2 })).json();
      expect([pile(game, 'gold').count, game.version, game.canUndo]).toEqual([28, 2, true]);
      game = (await act(owner, game, { type: 'return', pileKey: 'gold' })).json();
      expect(pile(game, 'gold').count).toBe(29);
      game = (await act(owner, game, { type: 'resource', resource: 'coins', delta: 7 })).json();
      game = (await act(owner, game, { type: 'resource', resource: 'buys', delta: 1 })).json();
      expect(game.resources).toEqual({ actions: 1, buys: 2, coins: 7 });
      game = (await act(owner, game, { type: 'vp', seat: 1, delta: 6 })).json();
      expect(game.players[1].vp).toBe(6);
      game = (await act(owner, game, { type: 'end_turn' })).json();
      expect([game.currentSeat, game.turnNumber, game.resources.coins, game.players[0].turnsTaken]).toEqual([1, 1, 0, 1]);
      game = (await act(owner, game, { type: 'end_turn' })).json();
      expect([game.currentSeat, game.turnNumber]).toEqual([0, 2]);
      expect(game.version).toBe(8);
    });

    it('persists state across requests', async () => {
      const created = await newGame();
      await act(owner, created, { type: 'take', pileKey: 'silver', quantity: 3 });
      const reloaded = (await call(owner, 'GET', `/games/${created.id}`)).json();
      expect(pile(reloaded, 'silver').count).toBe(37);
    });

    it('lets manual piles be set and refuses it for enforced piles', async () => {
      const [rows] = await pool.query<mysql.RowDataPacket[]>(
        "SELECT c.id FROM cards c JOIN card_types t ON t.card_id = c.id WHERE t.type = 'Castle' AND c.kingdom = 1 AND c.cost_coins IS NOT NULL LIMIT 1",
      );
      const castleId = String(rows[0]?.['id']);
      const created = (
        await call(owner, 'POST', '/games', { players: [{ name: 'A' }, { name: 'B' }], cardIds: [castleId, ...kingdomIds.slice(1)] })
      ).json();
      const key = `card:${castleId}`;
      const set = await act(owner, created, { type: 'set_pile', pileKey: key, count: 8 });
      expect(pile(set.json(), key).count).toBe(8);
      const refused = await act(owner, set.json(), { type: 'set_pile', pileKey: 'gold', count: 3 });
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toEqual({ error: 'invalid_action', reason: 'pile_enforced' });
    });

    it('rejects invalid moves without changing anything', async () => {
      const game = await newGame();
      const reason = async (action: object) => {
        const res = await act(owner, game, action);
        expect(res.statusCode).toBe(422);
        return res.json().reason;
      };
      expect(await reason({ type: 'take', pileKey: 'province', quantity: 9 })).toBe('pile_empty');
      expect(await reason({ type: 'return', pileKey: 'province' })).toBe('pile_full');
      expect(await reason({ type: 'take', pileKey: 'nope' })).toBe('unknown_pile');
      expect(await reason({ type: 'take' })).toBe('missing_field');
      expect(await reason({ type: 'resource', resource: 'coins', delta: 0 })).toBe('missing_field');
      expect(await reason({ type: 'resource', resource: 'coins', delta: -1 })).toBe('out_of_range');
      expect(await reason({ type: 'vp', seat: 3, delta: 1 })).toBe('unknown_player');
      expect(await reason({ type: 'undo' })).toBe('nothing_to_undo');
      expect((await call(owner, 'GET', `/games/${game.id}`)).json().version).toBe(1);
      expect((await act(owner, game, { type: 'dance' })).statusCode).toBe(400);
      expect((await act(owner, game, { type: 'take', pileKey: 'gold', quantity: 21 })).statusCode).toBe(400);
    });

    it('answers 409 with the current game when the version is stale', async () => {
      const game = await newGame();
      await act(owner, game, { type: 'take', pileKey: 'gold' });
      const stale = await act(owner, game, { type: 'take', pileKey: 'gold' });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error).toBe('version_conflict');
      expect(pile(stale.json().game, 'gold').count).toBe(29);
    });

    it('lets only one of two simultaneous actions on the same version win', async () => {
      const game = await newGame();
      const results = await Promise.all([
        act(owner, game, { type: 'take', pileKey: 'gold' }),
        act(owner, game, { type: 'take', pileKey: 'gold' }),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      expect(pile((await call(owner, 'GET', `/games/${game.id}`)).json(), 'gold').count).toBe(29);
    });
  });

  describe('ending a game', () => {
    it('ends at end of turn when the Province pile is empty, reports the result, and blocks further moves', async () => {
      let game = await newGame();
      game = (await act(owner, game, { type: 'take', pileKey: 'province', quantity: 8 })).json();
      expect(game.status).toBe('active');
      expect(game.endReasons).toEqual(['province_empty']);
      game = (await act(owner, game, { type: 'vp', seat: 0, delta: 31 })).json();
      game = (await act(owner, game, { type: 'vp', seat: 1, delta: 31 })).json();
      game = (await act(owner, game, { type: 'end_turn' })).json();
      expect(game.status).toBe('finished');
      expect(game.endedAt).not.toBeNull();
      expect(game.endReasons).toEqual([]);
      // Equal points: seat 1 has had one turn fewer than seat 0, who just ended the game, so seat 1 wins.
      expect(game.result).toEqual({ winners: [1], tiedOnPoints: true });
      const blocked = await act(owner, game, { type: 'take', pileKey: 'gold' });
      expect(blocked.json()).toEqual({ error: 'invalid_action', reason: 'game_not_active' });
    });

    it('ends when three piles are empty', async () => {
      let game = await newGame();
      for (const key of ['curse', 'estate', 'duchy']) {
        game = (await act(owner, game, { type: 'take', pileKey: key, quantity: pile(game, key).count })).json();
      }
      expect(game.endReasons).toEqual(['piles_empty']);
      expect((await act(owner, game, { type: 'end_turn' })).json().status).toBe('finished');
    });

    it('supports finishing and abandoning by hand', async () => {
      const a = await newGame();
      expect((await act(owner, a, { type: 'finish' })).json().status).toBe('finished');
      const b = await newGame();
      const abandoned = (await act(owner, b, { type: 'abandon' })).json();
      expect(abandoned.status).toBe('abandoned');
      expect(abandoned.result).toBeNull();
    });
  });

  describe('undo', () => {
    it('steps back one change at a time, including the end of a game', async () => {
      let game = await newGame();
      game = (await act(owner, game, { type: 'take', pileKey: 'province', quantity: 8 })).json();
      game = (await act(owner, game, { type: 'end_turn' })).json();
      expect(game.status).toBe('finished');

      game = (await act(owner, game, { type: 'undo' })).json();
      expect([game.status, game.currentSeat, game.endedAt, game.players[0].turnsTaken]).toEqual(['active', 0, null, 0]);
      expect(pile(game, 'province').count).toBe(0);

      game = (await act(owner, game, { type: 'undo' })).json();
      expect(pile(game, 'province').count).toBe(8);
      expect(game.canUndo).toBe(false);
      expect(game.version).toBe(5);
    });

    it('restores resources, victory points and the turn', async () => {
      let game = await newGame();
      game = (await act(owner, game, { type: 'resource', resource: 'coins', delta: 4 })).json();
      game = (await act(owner, game, { type: 'vp', seat: 0, delta: 3 })).json();
      game = (await act(owner, game, { type: 'end_turn' })).json();
      game = (await act(owner, game, { type: 'undo' })).json();
      expect([game.currentSeat, game.resources.coins, game.players[0].vp, game.players[0].turnsTaken]).toEqual([0, 4, 3, 0]);
      game = (await act(owner, game, { type: 'undo' })).json();
      expect(game.players[0].vp).toBe(0);
    });
  });

  describe('ownership', () => {
    it('keeps games private to the person who started them', async () => {
      const mine = await newGame(owner);
      const theirs = await newGame(other, ['Cy', 'Di']);

      const ownerList = (await call(owner, 'GET', '/games')).json().games as { id: string }[];
      const otherList = (await call(other, 'GET', '/games')).json().games as { id: string; players: string[] }[];
      expect(ownerList.some((g) => g.id === mine.id)).toBe(true);
      expect(ownerList.some((g) => g.id === theirs.id)).toBe(false);
      expect(otherList.map((g) => g.id)).toEqual([theirs.id]);
      expect(otherList[0]?.players).toEqual(['Cy', 'Di']);

      expect((await call(other, 'GET', `/games/${mine.id}`)).statusCode).toBe(404);
      expect((await act(other, mine, { type: 'finish' })).statusCode).toBe(404);
      expect((await call(owner, 'GET', `/games/${mine.id}`)).json().status).toBe('active');
      expect((await call(owner, 'GET', '/games/11111111-1111-4111-8111-111111111111')).statusCode).toBe(404);
      expect((await call(null, 'GET', '/games')).statusCode).toBe(401);
      expect((await call(owner, 'GET', '/games/not-a-uuid')).statusCode).toBe(400);
    });
  });
});
