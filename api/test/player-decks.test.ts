import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadDataset } from '../src/cards/dataset.js';
import { importDataset } from '../src/cards/importer.js';
import { rebuildDecks, replayDecks } from '../src/games/rebuild.js';
import { loadRules } from '../src/games/rules.js';
import { applyMigrations } from '../src/migrate.js';
import { resetDatabase } from './helpers/db.js';

const dbHost = process.env['TEST_DB_HOST'];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const silent = { info: () => undefined };
const quiet = { info: () => undefined, warn: () => undefined };
const SETUP_TOKEN = 'test-setup-token-1234';
const PASSWORD = 'correct horse battery';
const MISSING_ID = '11111111-1111-4111-8111-111111111111';

interface Session {
  cookie: string;
  csrf: string;
}

type Step = Record<string, unknown>;
interface DeckEntry {
  key: string;
  label: string;
  count: number;
}

describe('replayDecks', () => {
  const keys = new Set(['silver', 'gold', 'curse']);
  const event = (seq: number, action: object, currentSeat = 0) => ({ seq, payload: { action, before: { currentSeat } } });

  it('credits takes to the named seat, or to the player whose turn it was', () => {
    const { decks, skipped } = replayDecks(
      [
        event(1, { type: 'take', pileKey: 'silver', quantity: 2 }, 0),
        event(2, { type: 'take', pileKey: 'gold', quantity: 1 }, 1),
        event(3, { type: 'take', pileKey: 'curse', quantity: 1, seat: 1 }, 0),
      ],
      keys,
    );
    expect(decks.get(0)).toEqual({ silver: 2 });
    expect(decks.get(1)).toEqual({ gold: 1, curse: 1 });
    expect(skipped).toBe(0);
  });

  it('applies returns and trashes, never below zero', () => {
    const { decks } = replayDecks(
      [
        event(1, { type: 'take', pileKey: 'silver', quantity: 2 }),
        event(2, { type: 'return', pileKey: 'silver', quantity: 1 }),
        event(3, { type: 'trash', pileKey: 'silver' }),
        event(4, { type: 'return', pileKey: 'silver', quantity: 3 }),
        event(5, { type: 'trash', pileKey: 'gold' }),
      ],
      keys,
    );
    expect(decks.get(0)).toEqual({ silver: 0 });
  });

  it('ignores other actions and skips unreadable events', () => {
    const { decks, skipped } = replayDecks(
      [
        event(1, { type: 'vp', seat: 0, delta: 3 }),
        event(2, { type: 'end_turn' }),
        { seq: 3, payload: null },
        { seq: 4, payload: 'text' },
        event(5, { type: 'take', pileKey: 'nope', quantity: 1 }),
        event(6, { type: 'take', pileKey: 'silver', quantity: 0 }),
        event(7, { type: 'take', pileKey: 'silver', quantity: 1, seat: 9 }),
        event(8, { type: 'take', pileKey: 'silver', quantity: 1.5 }),
        event(9, { type: 'take', pileKey: 'silver', quantity: 1 }),
      ],
      keys,
    );
    expect(skipped).toBe(6);
    expect(decks.get(0)).toEqual({ silver: 1 });
  });
});

describe.skipIf(!dbHost)('player decks against MySQL', () => {
  let pool: mysql.Pool;
  let app: FastifyInstance;
  let owner: Session;
  let friend: Session;
  let kingdomIds: string[] = [];
  let kingdomPileKeys: string[] = [];

  const call = (session: Session | null, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      payload: payload as object | undefined,
      headers: session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {},
    });

  const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0] ?? '';

  const create = async (session: Session, names: string[]) => {
    const res = await call(session, 'POST', '/games', { players: names.map((name) => ({ name })), cardIds: kingdomIds });
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  };

  const act = (session: Session, game: { id: string; version: number }, action: object, version = game.version) =>
    call(session, 'POST', `/games/${game.id}/actions`, { expectedVersion: version, action });

  const play = async (session: Session, names: string[], steps: Step[]) => {
    let game = await create(session, names);
    for (const step of steps) {
      const res = await act(session, game, step);
      expect(res.statusCode, `${JSON.stringify(step)} ${res.body}`).toBe(200);
      game = res.json();
    }
    return game;
  };

  const deck = (game: { players: { cards: DeckEntry[] }[] }, seat: number): [string, number][] =>
    (game.players[seat]?.cards ?? []).map((c) => [c.key, c.count]);

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
    const probe = await create(owner, ['Ann', 'Ben']);
    kingdomPileKeys = (probe.piles as { key: string; kind: string }[]).filter((p) => p.kind === 'kingdom').map((p) => p.key);
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('taking, returning and trashing', () => {
    it('starts a new game as tracked with empty decks', async () => {
      const game = await create(owner, ['Ann', 'Ben']);
      expect(game.cardsSource).toBe('tracked');
      expect(game.players.map((p: { cards: unknown[] }) => p.cards)).toEqual([[], []]);
    });

    it('credits the current player, or a chosen player without using a Buy', async () => {
      let game = await create(owner, ['Ann', 'Ben']);
      game = (await act(owner, game, { type: 'take', pileKey: 'curse', seat: 1 })).json();
      expect(deck(game, 1)).toEqual([['curse', 1]]);
      expect(deck(game, 0)).toEqual([]);
      expect(game.resources.buys).toBe(1);
      game = (await act(owner, game, { type: 'take', pileKey: 'silver' })).json();
      expect(deck(game, 0)).toEqual([['silver', 1]]);
      expect(game.resources.buys).toBe(0);
      expect(game.players[0].cards).toEqual([{ key: 'silver', label: 'Silver', count: 1 }]);
    });

    it('lists cards in the order the piles are shown', async () => {
      let game = await create(owner, ['Ann', 'Ben']);
      const kingdomKey = kingdomPileKeys[0] as string;
      game = (await act(owner, game, { type: 'take', pileKey: kingdomKey })).json();
      game = (await act(owner, game, { type: 'take', pileKey: 'copper' })).json();
      game = (await act(owner, game, { type: 'take', pileKey: 'gold' })).json();
      const keys = (game.players[0].cards as DeckEntry[]).map((c) => c.key);
      const order = (game.piles as { key: string }[]).map((p) => p.key).filter((k) => keys.includes(k));
      expect(keys).toEqual(order);
    });

    it('returns and trashes cards and keeps the saved rows in step', async () => {
      let game = await create(owner, ['Ann', 'Ben']);
      game = (await act(owner, game, { type: 'take', pileKey: 'estate', quantity: 3 })).json();
      game = (await act(owner, game, { type: 'trash', pileKey: 'estate' })).json();
      game = (await act(owner, game, { type: 'return', pileKey: 'estate' })).json();
      expect(deck(game, 0)).toEqual([['estate', 1]]);
      const [rows] = await pool.query<RowDataPacket[]>('SELECT seat, pile_key, count FROM game_player_cards WHERE game_id = ?', [game.id]);
      expect(rows.map((r) => [r['seat'], r['pile_key'], r['count']])).toEqual([[0, 'estate', 1]]);
      game = (await act(owner, game, { type: 'trash', pileKey: 'estate' })).json();
      const [after] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM game_player_cards WHERE game_id = ?', [game.id]);
      expect(Number(after[0]?.['n'])).toBe(0);
    });

    it('refuses to trash a card nobody holds, an unknown seat, and bad input', async () => {
      const game = await create(owner, ['Ann', 'Ben']);
      const refused = await act(owner, game, { type: 'trash', pileKey: 'estate' });
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toEqual({ error: 'invalid_action', reason: 'not_owned' });
      const seat = await act(owner, game, { type: 'take', pileKey: 'silver', seat: 2 });
      expect(seat.json()).toEqual({ error: 'invalid_action', reason: 'unknown_player' });
      expect((await act(owner, game, { type: 'take', pileKey: 'silver', seat: 4 })).statusCode).toBe(400);
      expect((await act(owner, game, { type: 'trash' })).statusCode).toBe(422);
      expect((await act(owner, game, { type: 'trash', pileKey: 'estate', extra: 1 })).statusCode).toBe(400);
    });

    it('undo restores the pile, the deck and Buys together, step by step', async () => {
      let game = await create(owner, ['Ann', 'Ben']);
      game = (await act(owner, game, { type: 'take', pileKey: 'curse', seat: 1 })).json();
      game = (await act(owner, game, { type: 'take', pileKey: 'silver' })).json();
      game = (await act(owner, game, { type: 'trash', pileKey: 'silver' })).json();
      expect(deck(game, 0)).toEqual([]);
      game = (await act(owner, game, { type: 'undo' })).json();
      expect(deck(game, 0)).toEqual([['silver', 1]]);
      game = (await act(owner, game, { type: 'undo' })).json();
      expect([deck(game, 0), deck(game, 1), game.resources.buys]).toEqual([[], [['curse', 1]], 1]);
      game = (await act(owner, game, { type: 'undo' })).json();
      expect([deck(game, 1), (game.piles as { key: string; count: number }[]).find((p) => p.key === 'curse')?.count]).toEqual([[], 10]);
      const [rows] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM game_player_cards WHERE game_id = ?', [game.id]);
      expect(Number(rows[0]?.['n'])).toBe(0);
    });

    it('keeps a deck when undo steps back past a snapshot saved before decks were tracked', async () => {
      let game = await create(owner, ['Ann', 'Ben']);
      game = (await act(owner, game, { type: 'take', pileKey: 'silver' })).json();
      const [events] = await pool.query<RowDataPacket[]>('SELECT payload FROM game_events WHERE game_id = ?', [game.id]);
      const payload = JSON.parse(String(events[0]?.['payload']));
      for (const player of payload.before.players) {
        delete player.cards;
      }
      await pool.query('UPDATE game_events SET payload = ? WHERE game_id = ?', [JSON.stringify(payload), game.id]);
      game = (await act(owner, game, { type: 'undo' })).json();
      expect(deck(game, 0)).toEqual([['silver', 1]]);
    });

    it("does not let another account change someone else's deck", async () => {
      const game = await create(owner, ['Ann', 'Ben']);
      expect((await act(friend, game, { type: 'take', pileKey: 'silver' })).statusCode).toBe(404);
      expect((await act(friend, game, { type: 'trash', pileKey: 'silver' })).statusCode).toBe(404);
    });
  });

  describe('rebuilding old games', () => {
    const stored = (action: object, currentSeat: number) => JSON.stringify({ action, before: { currentSeat } });

    it('fills decks from the saved events, once, and leaves tracked games alone', async () => {
      const oldGame = await create(owner, ['Ann', 'Ben']);
      const tracked = await play(owner, ['Ann', 'Ben'], [{ type: 'take', pileKey: 'gold' }]);
      await pool.query("UPDATE games SET cards_source = 'none' WHERE id = ?", [oldGame.id]);
      await pool.query('DELETE FROM game_events WHERE game_id = ?', [oldGame.id]);
      const events: [number, string, string][] = [
        [1, 'take', stored({ type: 'take', pileKey: 'silver', quantity: 2 }, 0)],
        [2, 'take', stored({ type: 'take', pileKey: 'gold', quantity: 1 }, 1)],
        [3, 'return', stored({ type: 'return', pileKey: 'silver', quantity: 1 }, 0)],
        [4, 'take', stored({ type: 'take', pileKey: 'mystery', quantity: 1 }, 0)],
        [5, 'take', 'not json'],
        [6, 'vp', stored({ type: 'vp', seat: 0, delta: 3 }, 0)],
      ];
      for (const [seq, type, payload] of events) {
        await pool.query('INSERT INTO game_events (game_id, seq, type, payload) VALUES (?, ?, ?, ?)', [oldGame.id, seq, type, payload]);
      }

      const summary = await rebuildDecks(pool, quiet);
      expect(summary).toEqual({ games: 1, rebuilt: 1, skippedEvents: 2 });

      const rebuilt = (await call(owner, 'GET', `/games/${oldGame.id}`)).json();
      expect(rebuilt.cardsSource).toBe('rebuilt');
      expect([deck(rebuilt, 0), deck(rebuilt, 1)]).toEqual([[['silver', 1]], [['gold', 1]]]);

      const untouched = (await call(owner, 'GET', `/games/${tracked.id}`)).json();
      expect(untouched.cardsSource).toBe('tracked');
      expect(deck(untouched, 0)).toEqual([['gold', 1]]);

      expect(await rebuildDecks(pool, quiet)).toEqual({ games: 0, rebuilt: 0, skippedEvents: 0 });
      const again = (await call(owner, 'GET', `/games/${oldGame.id}`)).json();
      expect(deck(again, 0)).toEqual([['silver', 1]]);
    });

    it('replaces anything recorded since the update so nothing is counted twice', async () => {
      const game = await play(owner, ['Ann', 'Ben'], [{ type: 'take', pileKey: 'silver' }]);
      await pool.query("UPDATE games SET cards_source = 'none' WHERE id = ?", [game.id]);
      await rebuildDecks(pool, quiet);
      const view = (await call(owner, 'GET', `/games/${game.id}`)).json();
      expect(deck(view, 0)).toEqual([['silver', 1]]);
      expect(view.cardsSource).toBe('rebuilt');
    });

    it('keeps tracking a rebuilt game that is still being played', async () => {
      let game = await play(owner, ['Ann', 'Ben'], [{ type: 'take', pileKey: 'silver' }]);
      await pool.query("UPDATE games SET cards_source = 'none' WHERE id = ?", [game.id]);
      await rebuildDecks(pool, quiet);
      game = (await call(owner, 'GET', `/games/${game.id}`)).json();
      game = (await act(owner, game, { type: 'take', pileKey: 'gold', seat: 1 })).json();
      expect([deck(game, 0), deck(game, 1)]).toEqual([[['silver', 1]], [['gold', 1]]]);
    });
  });

  describe('game log and stats', () => {
    const names = ['Dana', 'Eli'];
    let kingdomKey = '';
    let kingdomCardId = '';

    beforeAll(async () => {
      kingdomKey = kingdomPileKeys[0] as string;
      kingdomCardId = kingdomKey.replace('card:', '');
      const win = [{ type: 'take', pileKey: kingdomKey }, { type: 'vp', seat: 0, delta: 9 }, { type: 'finish' }];
      await play(owner, names, [...win.slice(0, 1), { type: 'take', pileKey: 'gold', seat: 1 }, ...win.slice(1)]);
      await play(owner, names, [{ type: 'take', pileKey: kingdomKey }, { type: 'take', pileKey: kingdomKey, seat: 0 }, { type: 'vp', seat: 1, delta: 4 }, { type: 'finish' }]);
      await play(owner, names, [{ type: 'take', pileKey: kingdomKey }, { type: 'vp', seat: 0, delta: 2 }, { type: 'vp', seat: 1, delta: 2 }, { type: 'finish' }]);
      await play(owner, names, [{ type: 'take', pileKey: 'silver', seat: 1 }, { type: 'vp', seat: 0, delta: 5 }, { type: 'finish' }]);
      const old = await play(owner, names, [{ type: 'take', pileKey: kingdomKey }, { type: 'vp', seat: 0, delta: 7 }, { type: 'finish' }]);
      await pool.query("UPDATE games SET cards_source = 'none' WHERE id = ?", [old.id]);
      await rebuildDecks(pool, quiet);
      await play(friend, ['Zed', 'Yan'], [{ type: 'take', pileKey: 'silver' }, { type: 'finish' }]);
    });

    it('shows final decks and where they came from on the game log', async () => {
      const games = (await call(owner, 'GET', '/history?limit=50')).json().games as { id: string }[];
      const logs = await Promise.all(games.map(async (g) => (await call(owner, 'GET', `/games/${g.id}/log`)).json()));
      expect(logs.filter((l) => l.cardsSource === 'rebuilt')).toHaveLength(1);
      expect(logs.filter((l) => l.cardsSource === 'tracked')).toHaveLength(games.length - 1);
      const rebuilt = logs.find((l) => l.cardsSource === 'rebuilt');
      expect(rebuilt.decks.map((d: { name: string }) => d.name)).toEqual(names);
      expect(rebuilt.decks[0].cards).toEqual([{ key: kingdomKey, label: expect.any(String), count: 1 }]);
      expect(rebuilt.decks[1].cards).toEqual([]);
    });

    it('computes "cards in your deck" win rates, copies and the rebuilt count', async () => {
      const stats = (await call(owner, 'GET', '/stats?player=dana')).json().stats;
      expect(stats.record).toEqual({ games: 5, wins: 3, losses: 1, ties: 1 });
      expect(stats.deckGames).toBe(5);
      expect(stats.rebuiltGames).toBe(1);
      expect(stats.deckCards).toHaveLength(1);
      expect(stats.deckCards[0]).toMatchObject({ cardId: kingdomCardId, games: 4, wins: 2, ties: 1 });
      expect(stats.deckCards[0].winRate).toBeCloseTo(0.5);
      expect(stats.deckCards[0].averageCopies).toBeCloseTo(5 / 4);
    });

    it("counts a player's own deck, not the opponent's", async () => {
      const stats = (await call(owner, 'GET', '/stats?player=Eli')).json().stats;
      expect(stats.deckCards).toEqual([]);
      expect(stats.deckGames).toBe(5);
    });

    it('leaves games without deck data out of the deck numbers', async () => {
      const game = await create(owner, ['Gus', 'Hal']);
      await pool.query("UPDATE games SET cards_source = 'none', status = 'finished', ended_at = NOW() WHERE id = ?", [game.id]);
      const stats = (await call(owner, 'GET', '/stats?player=Gus')).json().stats;
      expect(stats.record.games).toBe(1);
      expect(stats.deckGames).toBe(0);
      expect(stats.deckCards).toEqual([]);
      const log = (await call(owner, 'GET', `/games/${game.id}/log`)).json();
      expect(log.cardsSource).toBe('none');
    });

    it("keeps each account's decks separate", async () => {
      expect((await call(friend, 'GET', `/games/${MISSING_ID}/log`)).statusCode).toBe(404);
      const stats = (await call(friend, 'GET', '/stats?player=Zed')).json().stats;
      expect(stats.deckGames).toBe(1);
      expect((await call(friend, 'GET', '/stats?player=Dana')).json().stats.deckGames).toBe(0);
    });
  });
});
