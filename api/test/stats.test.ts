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

type Step = Record<string, unknown>;

describe.skipIf(!dbHost)('game history, stats and log against MySQL', () => {
  let pool: mysql.Pool;
  let app: FastifyInstance;
  let owner: Session;
  let friend: Session;
  let kingdomIds: string[] = [];
  const ids: Record<string, string> = {};

  const call = (session: Session | null, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      payload: payload as object | undefined,
      headers: session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {},
    });

  const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0] ?? '';

  /** Creates a game and plays the steps in order, always sending the latest version. */
  const play = async (session: Session, names: string[], steps: Step[]): Promise<string> => {
    const created = await call(session, 'POST', '/games', { players: names.map((name) => ({ name })), cardIds: kingdomIds });
    expect(created.statusCode, created.body).toBe(201);
    let version = created.json().version as number;
    const id = created.json().id as string;
    for (const action of steps) {
      const res = await call(session, 'POST', `/games/${id}/actions`, { expectedVersion: version, action });
      expect(res.statusCode, `${JSON.stringify(action)} ${res.body}`).toBe(200);
      version = res.json().version as number;
    }
    return id;
  };

  const take = (pileKey: string, quantity: number): Step => ({ type: 'take', pileKey, quantity });
  const vp = (seat: number, delta: number): Step => ({ type: 'vp', seat, delta });

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
    friend = { cookie: cookieOf(redeem), csrf: redeem.json().csrfToken };
    kingdomIds = (await call(owner, 'GET', '/kingdoms/random')).json().items.map((c: { id: string }) => c.id);

    ids['provinces'] = await play(owner, ['Ann', 'Ben'], [vp(0, 30), vp(1, 20), take('province', 8), { type: 'end_turn' }]);
    ids['early'] = await play(owner, ['Ann', 'Ben'], [vp(0, 10), vp(1, 10), { type: 'finish' }]);
    ids['piles'] = await play(owner, ['Ann', 'Ben'], [
      vp(0, 5),
      vp(1, 15),
      take('curse', 10),
      take('silver', 20),
      take('silver', 20),
      take('gold', 20),
      take('gold', 10),
      { type: 'end_turn' },
    ]);
    ids['abandoned'] = await play(owner, ['Ann', 'Ben'], [vp(0, 99), { type: 'abandon' }]);
    ids['active'] = await play(owner, ['Ann', 'Ben'], [vp(0, 1), take('gold', 1), { type: 'undo' }]);
    ids['friends'] = await play(friend, ['Zed', 'Yan'], [vp(0, 4), { type: 'finish' }]);
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('authentication and validation', () => {
    it('needs a session', async () => {
      for (const url of ['/history', '/stats', `/games/${MISSING_ID}/log`]) {
        expect((await call(null, 'GET', url)).statusCode, url).toBe(401);
      }
    });

    it.each([
      ['/history?limit=0'],
      ['/history?limit=51'],
      ['/history?limit=x'],
      ['/history?before=garbage'],
      ['/history?before=1_not-a-uuid'],
      ['/history?extra=1'],
      ['/stats?player='],
      ['/stats?player=%00x'],
      ['/stats?player=%20%20'],
      [`/stats?player=${'x'.repeat(33)}`],
      ['/stats?extra=1'],
      ['/games/not-a-uuid/log'],
    ])('rejects %s with 400', async (url) => {
      expect((await call(owner, 'GET', url)).statusCode).toBe(400);
    });
  });

  describe('history', () => {
    it('lists only finished games', async () => {
      const res = await call(owner, 'GET', '/history');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.next).toBeNull();
      expect(new Set(body.games.map((g: { id: string }) => g.id))).toEqual(new Set([ids['provinces'], ids['early'], ids['piles']]));
    });

    it('describes each game', async () => {
      const games = (await call(owner, 'GET', '/history')).json().games as { id: string; ending: string; players: { name: string; vp: number; winner: boolean }[]; kingdom: string[]; endedAt: string; turns: number }[];
      const byId = new Map(games.map((g) => [g.id, g]));

      const provinces = byId.get(ids['provinces'] as string);
      expect(provinces?.ending).toBe('province_empty');
      expect(provinces?.players).toEqual([
        { name: 'Ann', vp: 30, turns: 1, winner: true },
        { name: 'Ben', vp: 20, turns: 0, winner: false },
      ]);
      expect(provinces?.kingdom).toHaveLength(10);
      expect(provinces?.turns).toBe(1);
      expect(Number.isNaN(Date.parse(provinces?.endedAt ?? ''))).toBe(false);

      const early = byId.get(ids['early'] as string);
      expect(early?.ending).toBe('ended_early');
      expect(early?.players.map((p) => p.winner)).toEqual([true, true]);

      const piles = byId.get(ids['piles'] as string);
      expect(piles?.ending).toBe('piles_empty');
      expect(piles?.players.map((p) => p.winner)).toEqual([false, true]);
    });

    it('pages through games without repeats even when they ended in the same second', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 5; guard += 1) {
        const res = await call(owner, 'GET', `/history?limit=2${cursor ? `&before=${cursor}` : ''}`);
        expect(res.statusCode, res.body).toBe(200);
        const page = res.json() as { games: { id: string }[]; next: string | null };
        expect(page.games.length).toBeLessThanOrEqual(2);
        seen.push(...page.games.map((g) => g.id));
        cursor = page.next;
        if (!cursor) {
          break;
        }
      }
      expect(cursor).toBeNull();
      expect(seen).toHaveLength(3);
      expect(new Set(seen).size).toBe(3);
    });

    it("never shows another user's games", async () => {
      const mine = (await call(friend, 'GET', '/history')).json().games as { id: string; players: { name: string }[] }[];
      expect(mine.map((g) => g.id)).toEqual([ids['friends']]);
      expect(mine[0]?.players.map((p) => p.name)).toEqual(['Zed', 'Yan']);
    });
  });

  describe('stats', () => {
    it('lists the names seen before a player is chosen', async () => {
      const body = (await call(owner, 'GET', '/stats')).json();
      expect(body.stats).toBeNull();
      expect(body.truncated).toBe(false);
      expect(body.players).toEqual([
        { name: 'Ann', games: 3 },
        { name: 'Ben', games: 3 },
      ]);
    });

    it('computes a record, averages, head-to-head, endings and cards', async () => {
      const body = (await call(owner, 'GET', '/stats?player=ann')).json();
      const stats = body.stats;
      expect(stats.name).toBe('Ann');
      expect(stats.record).toEqual({ games: 3, wins: 1, losses: 1, ties: 1 });
      expect(stats.ambiguousGames).toBe(0);
      expect(stats.averages.score).toBeCloseTo(15);
      expect(stats.averages.opponentScore).toBeCloseTo(15);
      expect(stats.averages.turns).toBeCloseTo(2 / 3);
      expect(stats.headToHead).toEqual([{ opponent: 'Ben', games: 3, wins: 1, losses: 1, ties: 1 }]);
      expect(stats.endings).toEqual({ province_empty: 1, colony_empty: 0, piles_empty: 1, ended_early: 1 });
      expect(stats.cards).toHaveLength(10);
      for (const card of stats.cards) {
        expect(card).toMatchObject({ games: 3, wins: 1, ties: 1 });
        expect(card.winRate).toBeCloseTo(1 / 3);
      }
    });

    it('mirrors the result for the opponent', async () => {
      const stats = (await call(owner, 'GET', '/stats?player=BEN')).json().stats;
      expect(stats.record).toEqual({ games: 3, wins: 1, losses: 1, ties: 1 });
      expect(stats.headToHead).toEqual([{ opponent: 'Ann', games: 3, wins: 1, losses: 1, ties: 1 }]);
    });

    it('returns zeros for a name that never played', async () => {
      const stats = (await call(owner, 'GET', '/stats?player=Nobody')).json().stats;
      expect(stats.record).toEqual({ games: 0, wins: 0, losses: 0, ties: 0 });
      expect(stats.averages).toEqual({ score: null, opponentScore: null, turns: null });
    });

    it("keeps each user's numbers separate", async () => {
      const body = (await call(friend, 'GET', '/stats?player=Zed')).json();
      expect(body.players).toEqual([
        { name: 'Yan', games: 1 },
        { name: 'Zed', games: 1 },
      ]);
      expect(body.stats.record).toEqual({ games: 1, wins: 1, losses: 0, ties: 0 });
      expect((await call(friend, 'GET', '/stats?player=Ann')).json().stats.record.games).toBe(0);
    });
  });

  describe('game log', () => {
    it('lists what was played, in order, with names and labels', async () => {
      const res = await call(owner, 'GET', `/games/${ids['provinces']}/log`);
      expect(res.statusCode).toBe(200);
      const items = res.json().items as Record<string, unknown>[];
      expect(items.map((i) => i['type'])).toEqual(['vp', 'vp', 'take', 'end_turn']);
      expect(items.map((i) => i['seq'])).toEqual([1, 2, 3, 4]);
      expect(items[0]).toMatchObject({ target: 'Ann', delta: 30, player: 'Ann', turn: 1 });
      expect(items[2]).toMatchObject({ label: 'Province', quantity: 8, player: 'Ann' });
    });

    it('leaves out an action that was undone', async () => {
      const items = (await call(owner, 'GET', `/games/${ids['active']}/log`)).json().items as { type: string }[];
      expect(items.map((i) => i.type)).toEqual(['vp']);
    });

    it('works for abandoned games and is empty for a game with no actions', async () => {
      const abandoned = (await call(owner, 'GET', `/games/${ids['abandoned']}/log`)).json().items as { type: string }[];
      expect(abandoned.map((i) => i.type)).toEqual(['vp', 'abandon']);
    });

    it('does not reveal games owned by someone else', async () => {
      expect((await call(friend, 'GET', `/games/${ids['provinces']}/log`)).statusCode).toBe(404);
      expect((await call(owner, 'GET', `/games/${ids['friends']}/log`)).statusCode).toBe(404);
      expect((await call(owner, 'GET', `/games/${MISSING_ID}/log`)).statusCode).toBe(404);
    });
  });
});
