import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { Authenticate } from '../auth/routes.js';
import { describeCards, type CardRow } from '../cards/routes.js';
import {
  applyAction,
  createGame,
  endReasons,
  gameResult,
  type Action,
  type GameState,
  type KingdomCard,
  type PileState,
  type PlayerState,
  type Resource,
} from './engine.js';
import type { Rules } from './rules.js';
import { appendEvent, insertGame, listGames, loadGame, popLastEvent, saveChanges, type GameMeta } from './store.js';

const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const RESOURCES: Resource[] = ['actions', 'buys', 'coins'];

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: UUID_PATTERN } },
} as const;

const createBody = {
  type: 'object',
  required: ['players', 'cardIds'],
  additionalProperties: false,
  properties: {
    players: {
      type: 'array',
      minItems: 2,
      maxItems: 4,
      items: {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: { name: { type: 'string', minLength: 1, maxLength: 32 } },
      },
    },
    cardIds: { type: 'array', minItems: 10, maxItems: 10, items: { type: 'string', pattern: UUID_PATTERN } },
    prosperityPiles: { type: 'boolean', default: false },
  },
} as const;

const actionBody = {
  type: 'object',
  required: ['expectedVersion', 'action'],
  additionalProperties: false,
  properties: {
    expectedVersion: { type: 'integer', minimum: 1 },
    action: {
      type: 'object',
      required: ['type'],
      additionalProperties: false,
      properties: {
        type: { enum: ['take', 'return', 'trash', 'set_pile', 'resource', 'vp', 'end_turn', 'finish', 'abandon', 'undo'] },
        pileKey: { type: 'string', minLength: 1, maxLength: 48 },
        quantity: { type: 'integer', minimum: 1, maximum: 20 },
        count: { type: 'integer', minimum: 0, maximum: 999 },
        resource: { enum: RESOURCES },
        delta: { type: 'integer', minimum: -99, maximum: 99 },
        seat: { type: 'integer', minimum: 0, maximum: 3 },
      },
    },
  },
} as const;

interface RawAction {
  type: string;
  pileKey?: string;
  quantity?: number;
  count?: number;
  resource?: Resource;
  delta?: number;
  seat?: number;
}

/** Turns the validated request action into an engine action, or null when a required field is missing. */
function toAction(raw: RawAction): Action | null {
  switch (raw.type) {
    case 'take':
    case 'return':
      return raw.pileKey === undefined
        ? null
        : { type: raw.type, pileKey: raw.pileKey, quantity: raw.quantity ?? 1, ...(raw.seat === undefined ? {} : { seat: raw.seat }) };
    case 'trash':
      return raw.pileKey === undefined ? null : { type: 'trash', pileKey: raw.pileKey, ...(raw.seat === undefined ? {} : { seat: raw.seat }) };
    case 'set_pile':
      return raw.pileKey === undefined || raw.count === undefined
        ? null
        : { type: 'set_pile', pileKey: raw.pileKey, count: raw.count };
    case 'resource':
      return raw.resource === undefined || raw.delta === undefined || raw.delta === 0
        ? null
        : { type: 'resource', resource: raw.resource, delta: raw.delta };
    case 'vp':
      return raw.seat === undefined || raw.delta === undefined || raw.delta === 0
        ? null
        : { type: 'vp', seat: raw.seat, delta: raw.delta };
    case 'end_turn':
    case 'finish':
    case 'abandon':
      return { type: raw.type };
    default:
      return null;
  }
}

/** A player's taken cards as `{key, label, count}`, in the order the piles are shown. */
export function deckList(player: PlayerState, piles: PileState[]): { key: string; label: string; count: number }[] {
  const cards = player.cards ?? {};
  return piles
    .filter((pile) => (cards[pile.key] ?? 0) > 0)
    .sort((a, b) => a.position - b.position)
    .map((pile) => ({ key: pile.key, label: pile.label, count: cards[pile.key] ?? 0 }));
}

export function gameView(meta: GameMeta, state: GameState, rules: Rules) {
  const active = state.status === 'active';
  return {
    id: meta.id,
    version: meta.version,
    status: state.status,
    playerCount: state.playerCount,
    turnNumber: state.turnNumber,
    currentSeat: state.currentSeat,
    resources: { actions: state.actions, buys: state.buys, coins: state.coins },
    players: state.players.map((player) => ({
      seat: player.seat,
      name: player.name,
      vp: player.vp,
      turnsTaken: player.turnsTaken,
      cards: deckList(player, state.piles),
    })),
    cardsSource: meta.cardsSource,
    piles: state.piles,
    notes: state.notes,
    startedAt: meta.startedAt.toISOString(),
    endedAt: meta.endedAt ? meta.endedAt.toISOString() : null,
    canUndo: meta.eventCount > 0,
    endReasons: active ? endReasons(state, rules) : [],
    result: state.status === 'finished' ? gameResult(state) : null,
  };
}

export function registerGames(
  app: FastifyInstance,
  options: { pool: Pool; authenticate: Authenticate; rules: Rules },
): void {
  const { pool, authenticate, rules } = options;
  const excludedTypes = [...rules.notSupplyTypes, ...rules.manualPileTypes, ...rules.needsExtraPileTypes];
  const excludedNames = [...rules.notSupplyCards, ...rules.manualPileCards];

  const userId = (request: { user: { id: number } | null }): number => {
    if (!request.user) {
      throw new Error('authenticate must run first');
    }
    return request.user.id;
  };

  const invalid = (reply: FastifyReply, reason: string): FastifyReply => reply.code(422).send({ error: 'invalid_action', reason });

  app.get(
    '/kingdoms/random',
    {
      onRequest: authenticate,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            edition: { type: 'array', maxItems: 24, items: { type: 'string', pattern: UUID_PATTERN } },
            count: { type: 'integer', minimum: 1, maximum: 10, default: 10 },
          },
        },
      },
    },
    async (request, reply) => {
      const query = request.query as { edition?: string[]; count: number };
      const where = [
        'c.kingdom = 1',
        'c.cost_coins IS NOT NULL',
        'NOT EXISTS (SELECT 1 FROM card_types ct WHERE ct.card_id = c.id AND ct.type IN (?))',
        'c.name_en NOT IN (?)',
      ];
      const params: unknown[] = [excludedTypes, excludedNames];
      if (query.edition && query.edition.length > 0) {
        where.push('EXISTS (SELECT 1 FROM edition_cards ec WHERE ec.card_id = c.id AND ec.edition_id IN (?))');
        params.push(query.edition);
      }
      const [rows] = await pool.query<CardRow[]>(
        `SELECT c.id, c.name_en, c.name_de, c.price, c.cost_coins, c.cost_potions, c.cost_debt, c.cost_variable, c.kingdom
           FROM cards c WHERE ${where.join(' AND ')} ORDER BY RAND()`,
        params,
      );
      const seen = new Set<string>();
      const picked = rows.filter((row) => {
        const name = row.name_en;
        if (seen.has(name)) {
          return false;
        }
        seen.add(name);
        return true;
      });
      if (picked.length < query.count) {
        return reply.code(422).send({ error: 'not_enough_cards' });
      }
      reply.header('Cache-Control', 'no-store');
      return { items: await describeCards(pool, picked.slice(0, query.count) as CardRow[]) };
    },
  );

  app.get('/games', { onRequest: authenticate }, async (request, reply) => {
    const games = await listGames(pool, userId(request));
    reply.header('Cache-Control', 'no-store');
    return {
      games: games.map((g) => ({
        id: g.id,
        status: g.status,
        playerCount: g.playerCount,
        turnNumber: g.turnNumber,
        startedAt: g.startedAt.toISOString(),
        endedAt: g.endedAt ? g.endedAt.toISOString() : null,
        players: g.players,
      })),
    };
  });

  app.post('/games', { onRequest: authenticate, schema: { body: createBody } }, async (request, reply) => {
    const body = request.body as { players: { name: string }[]; cardIds: string[]; prosperityPiles: boolean };
    const [cardRows] = await pool.query<RowDataPacket[]>(
      'SELECT id, name_en, cost_coins, cost_potions FROM cards WHERE id IN (?) AND kingdom = 1',
      [body.cardIds],
    );
    const [typeRows] = await pool.query<RowDataPacket[]>('SELECT card_id, type FROM card_types WHERE card_id IN (?)', [
      body.cardIds,
    ]);
    const types = new Map<string, string[]>();
    for (const t of typeRows) {
      const list = types.get(String(t['card_id'])) ?? [];
      list.push(String(t['type']));
      types.set(String(t['card_id']), list);
    }
    const kingdom: KingdomCard[] = cardRows.map((c) => ({
      id: String(c['id']),
      nameEn: String(c['name_en']),
      types: types.get(String(c['id'])) ?? [],
      costCoins: c['cost_coins'] === null ? null : Number(c['cost_coins']),
      costPotions: Number(c['cost_potions']),
    }));
    if (new Set(body.cardIds).size !== body.cardIds.length || kingdom.length !== body.cardIds.length) {
      return reply.code(422).send({ error: 'invalid_game', reason: 'unknown_card' });
    }
    const created = createGame(rules, {
      playerNames: body.players.map((p) => p.name),
      kingdom,
      prosperityPiles: body.prosperityPiles,
    });
    if (!created.ok) {
      return reply.code(422).send({ error: 'invalid_game', reason: created.reason });
    }

    const id = randomUUID();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await insertGame(conn, id, userId(request), created.state);
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => undefined);
      throw err;
    } finally {
      conn.release();
    }
    request.log.info({ event: 'game_created', userId: userId(request), gameId: id, players: body.players.length }, 'games');
    const loaded = await loadGame(pool, id, userId(request), false);
    if (!loaded) {
      throw new Error('Created game could not be loaded');
    }
    return reply.code(201).send(gameView(loaded.meta, loaded.state, rules));
  });

  app.get('/games/:id', { onRequest: authenticate, schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const loaded = await loadGame(pool, id, userId(request), false);
    if (!loaded) {
      return reply.code(404).send({ error: 'not_found' });
    }
    reply.header('Cache-Control', 'no-store');
    return gameView(loaded.meta, loaded.state, rules);
  });

  app.post(
    '/games/:id/actions',
    { onRequest: authenticate, schema: { params: idParams, body: actionBody } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { expectedVersion: number; action: RawAction };
      const owner = userId(request);

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const loaded = await loadGame(conn, id, owner, true);
        if (!loaded) {
          await conn.rollback();
          return reply.code(404).send({ error: 'not_found' });
        }
        if (loaded.meta.version !== body.expectedVersion) {
          await conn.rollback();
          return reply.code(409).send({ error: 'version_conflict', game: gameView(loaded.meta, loaded.state, rules) });
        }

        if (body.action.type === 'undo') {
          const previous = await popLastEvent(conn, id);
          if (!previous) {
            await conn.rollback();
            return invalid(reply, 'nothing_to_undo');
          }
          await saveChanges(conn, id, loaded.state, previous);
        } else {
          const action = toAction(body.action);
          if (!action) {
            await conn.rollback();
            return invalid(reply, 'missing_field');
          }
          const result = applyAction(loaded.state, action, rules);
          if (!result.ok) {
            await conn.rollback();
            return invalid(reply, result.reason);
          }
          await appendEvent(conn, id, action.type, { action, before: loaded.state });
          await saveChanges(conn, id, loaded.state, result.state);
        }
        await conn.commit();
        request.log.info({ event: 'game_action', userId: owner, gameId: id, action: body.action.type }, 'games');
      } catch (err) {
        await conn.rollback().catch(() => undefined);
        throw err;
      } finally {
        conn.release();
      }

      const updated = await loadGame(pool, id, owner, false);
      if (!updated) {
        throw new Error('Updated game could not be loaded');
      }
      return gameView(updated.meta, updated.state, rules);
    },
  );
}
