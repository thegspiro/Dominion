import type { FastifyInstance } from 'fastify';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { Authenticate } from '../auth/routes.js';
import type { PileKind, PileState, PlayerState } from '../games/engine.js';
import type { Rules } from '../games/rules.js';
import { computeStats, historyItem, MIN_CARD_GAMES, playerNames, type FinishedGame } from './compute.js';
import { logItem, type LogItem } from './log.js';

const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const CURSOR_PATTERN = '^[0-9]{1,12}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
export const STATS_GAME_LIMIT = 5000;
const DEFAULT_PAGE = 20;
const MAX_PAGE = 50;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const historyQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE, default: DEFAULT_PAGE },
    before: { type: 'string', pattern: CURSOR_PATTERN },
  },
} as const;

const statsQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { player: { type: 'string', minLength: 1, maxLength: 32 } },
} as const;

const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID_PATTERN } } } as const;

/** Loads finished games for one owner, newest first, with their players and piles. */
async function loadFinished(
  pool: Pool,
  owner: number,
  limit: number,
  before?: { epoch: number; id: string },
): Promise<FinishedGame[]> {
  const params: unknown[] = [owner];
  let cursor = '';
  if (before) {
    cursor = 'AND (UNIX_TIMESTAMP(ended_at) < ? OR (UNIX_TIMESTAMP(ended_at) = ? AND id < ?))';
    params.push(before.epoch, before.epoch, before.id);
  }
  params.push(limit);
  const [games] = await pool.query<RowDataPacket[]>(
    `SELECT id, UNIX_TIMESTAMP(ended_at) AS ended_epoch FROM games
      WHERE owner_user_id = ? AND status = 'finished' AND ended_at IS NOT NULL ${cursor}
      ORDER BY ended_at DESC, id DESC LIMIT ?`,
    params,
  );
  if (games.length === 0) {
    return [];
  }
  const ids = games.map((g) => String(g['id']));
  const [players] = await pool.query<RowDataPacket[]>(
    'SELECT game_id, seat, name, vp, turns_taken FROM game_players WHERE game_id IN (?) ORDER BY game_id, seat',
    [ids],
  );
  const [piles] = await pool.query<RowDataPacket[]>(
    'SELECT game_id, pile_key, label, kind, card_id, count FROM game_piles WHERE game_id IN (?) ORDER BY game_id, position',
    [ids],
  );
  const playersBy = new Map<string, PlayerState[]>();
  for (const row of players) {
    const list = playersBy.get(String(row['game_id'])) ?? [];
    list.push({ seat: Number(row['seat']), name: String(row['name']), vp: Number(row['vp']), turnsTaken: Number(row['turns_taken']) });
    playersBy.set(String(row['game_id']), list);
  }
  const pilesBy = new Map<string, FinishedGame['piles']>();
  for (const row of piles) {
    const list = pilesBy.get(String(row['game_id'])) ?? [];
    list.push({
      key: String(row['pile_key']),
      label: String(row['label']),
      kind: row['kind'] as PileKind,
      cardId: row['card_id'] === null ? null : String(row['card_id']),
      count: Number(row['count']),
    } satisfies Pick<PileState, 'key' | 'label' | 'kind' | 'cardId' | 'count'>);
    pilesBy.set(String(row['game_id']), list);
  }
  return games.map((g) => ({
    id: String(g['id']),
    endedAtEpoch: Number(g['ended_epoch']),
    players: playersBy.get(String(g['id'])) ?? [],
    piles: pilesBy.get(String(g['id'])) ?? [],
  }));
}

export function registerStats(app: FastifyInstance, options: { pool: Pool; authenticate: Authenticate; rules: Rules }): void {
  const { pool, authenticate, rules } = options;

  const userId = (request: { user: { id: number } | null }): number => {
    if (!request.user) {
      throw new Error('authenticate must run first');
    }
    return request.user.id;
  };

  app.get('/history', { onRequest: authenticate, schema: { querystring: historyQuery } }, async (request, reply) => {
    const query = request.query as { limit: number; before?: string };
    let before: { epoch: number; id: string } | undefined;
    if (query.before) {
      const [epoch, id] = query.before.split('_');
      before = { epoch: Number(epoch), id: String(id) };
    }
    const rows = await loadFinished(pool, userId(request), query.limit + 1, before);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    reply.header('Cache-Control', 'no-store');
    return {
      games: page.map((game) => historyItem(game, rules)),
      next: rows.length > query.limit && last ? `${last.endedAtEpoch}_${last.id}` : null,
    };
  });

  app.get('/stats', { onRequest: authenticate, schema: { querystring: statsQuery } }, async (request, reply) => {
    const { player } = request.query as { player?: string };
    if (player !== undefined && (CONTROL_CHARACTERS.test(player) || player.trim() === '')) {
      return reply.code(400).send({ error: 'invalid_player' });
    }
    const games = await loadFinished(pool, userId(request), STATS_GAME_LIMIT + 1);
    const truncated = games.length > STATS_GAME_LIMIT;
    const used = truncated ? games.slice(0, STATS_GAME_LIMIT) : games;
    reply.header('Cache-Control', 'no-store');
    return {
      players: playerNames(used),
      truncated,
      minCardGames: MIN_CARD_GAMES,
      stats: player === undefined ? null : computeStats(used, player, rules),
    };
  });

  app.get('/games/:id/log', { onRequest: authenticate, schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const [owned] = await pool.query<RowDataPacket[]>('SELECT id FROM games WHERE id = ? AND owner_user_id = ?', [id, userId(request)]);
    if (owned.length === 0) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const [events] = await pool.query<RowDataPacket[]>(
      'SELECT seq, payload, UNIX_TIMESTAMP(created_at) AS at FROM game_events WHERE game_id = ? ORDER BY seq',
      [id],
    );
    const items: LogItem[] = [];
    for (const event of events) {
      let payload: unknown;
      try {
        payload = JSON.parse(String(event['payload']));
      } catch {
        payload = null;
      }
      const item = logItem(Number(event['seq']), Number(event['at']), payload);
      if (item) {
        items.push(item);
      } else {
        request.log.warn({ gameId: id, seq: event['seq'] }, 'skipped an unreadable game event');
      }
    }
    reply.header('Cache-Control', 'no-store');
    return { items };
  });
}
