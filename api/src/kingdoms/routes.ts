import { randomInt, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { Authenticate } from '../auth/routes.js';
import { describeCards, type CardRow } from '../cards/routes.js';
import type { Rules } from '../games/rules.js';
import { drawCards, type DrawCard } from './draw.js';
import { drawPoolClause, playableClause } from './pool.js';

const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const KINGDOM_SIZE = 10;
const MAX_KINGDOMS = 200;
const MAX_REQUIRED = KINGDOM_SIZE;
const MAX_PREFERENCES = 500;
const ER_DUP_ENTRY = 1062;
const CARD_COLUMNS =
  'c.id, c.name_en, c.name_de, c.price, c.cost_coins, c.cost_potions, c.cost_debt, c.cost_variable, c.kingdom';

const uuid = { type: 'string', pattern: UUID_PATTERN } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;

const drawBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    editions: { type: 'array', maxItems: 30, items: uuid },
    minCost: { type: 'integer', minimum: 0, maximum: 20 },
    maxCost: { type: 'integer', minimum: 0, maximum: 20 },
    excludeTypes: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 32 } },
    lockedIds: { type: 'array', maxItems: KINGDOM_SIZE, items: uuid },
    count: { type: 'integer', minimum: 1, maximum: KINGDOM_SIZE, default: KINGDOM_SIZE },
  },
} as const;

const saveBody = {
  type: 'object',
  required: ['name', 'cardIds'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 60 },
    cardIds: { type: 'array', minItems: KINGDOM_SIZE, maxItems: KINGDOM_SIZE, items: uuid },
  },
} as const;

const preferenceParams = { type: 'object', required: ['cardId'], properties: { cardId: uuid } } as const;
const preferenceBody = {
  type: 'object',
  required: ['preference'],
  additionalProperties: false,
  properties: { preference: { enum: ['ban', 'require', null] } },
} as const;

function isDuplicate(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { errno?: number }).errno === ER_DUP_ENTRY;
}

/** Trims the name and refuses control characters, which have no place in a label. */
function cleanName(name: string): string | null {
  const trimmed = name.trim();
  return trimmed === '' || /[\u0000-\u001f\u007f]/.test(trimmed) ? null : trimmed;
}

export function registerKingdoms(
  app: FastifyInstance,
  options: { pool: Pool; authenticate: Authenticate; rules: Rules },
): void {
  const { pool, authenticate, rules } = options;
  const playable = playableClause(rules);
  const drawPool = drawPoolClause(rules);

  const userId = (request: { user: { id: number } | null }): number => {
    if (!request.user) {
      throw new Error('authenticate must run first');
    }
    return request.user.id;
  };

  async function preferences(owner: number): Promise<{ id: string; name: { en: string }; preference: 'ban' | 'require' }[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT c.id, c.name_en, p.preference FROM card_preferences p JOIN cards c ON c.id = p.card_id
        WHERE p.owner_user_id = ? ORDER BY c.name_en`,
      [owner],
    );
    return rows.map((r) => ({
      id: String(r['id']),
      name: { en: String(r['name_en']) },
      preference: r['preference'] === 'require' ? 'require' : 'ban',
    }));
  }

  async function cardViews(ids: string[]) {
    if (ids.length === 0) {
      return [];
    }
    const [rows] = await pool.query<CardRow[]>(
      `SELECT ${CARD_COLUMNS} FROM cards c WHERE c.id IN (?) ORDER BY c.cost_coins, c.name_en, c.id`,
      [ids],
    );
    return describeCards(pool, rows);
  }

  app.get('/card-preferences', { onRequest: authenticate }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { preferences: await preferences(userId(request)) };
  });

  app.put(
    '/card-preferences/:cardId',
    { onRequest: authenticate, schema: { params: preferenceParams, body: preferenceBody } },
    async (request, reply) => {
      const owner = userId(request);
      const { cardId } = request.params as { cardId: string };
      const { preference } = request.body as { preference: 'ban' | 'require' | null };

      const [found] = await pool.query<RowDataPacket[]>(
        `SELECT c.id, c.name_en, (${playable.sql}) AS is_playable FROM cards c WHERE c.id = ? LIMIT 1`,
        [...playable.params, cardId],
      );
      const card = found[0];
      if (!card) {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (preference === 'require' && Number(card['is_playable']) !== 1) {
        return reply.code(422).send({ error: 'invalid_preference', reason: 'not_a_supply_card' });
      }

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query('SELECT id FROM users WHERE id = ? FOR UPDATE', [owner]);
        if (preference === null) {
          await conn.query('DELETE FROM card_preferences WHERE owner_user_id = ? AND card_id = ?', [owner, cardId]);
        } else {
          const [counts] = await conn.query<RowDataPacket[]>(
            `SELECT COUNT(*) AS total, COALESCE(SUM(preference = 'require' AND card_id <> ?), 0) AS required
               FROM card_preferences WHERE owner_user_id = ?`,
            [cardId, owner],
          );
          const [existing] = await conn.query<RowDataPacket[]>(
            'SELECT 1 FROM card_preferences WHERE owner_user_id = ? AND card_id = ?',
            [owner, cardId],
          );
          if (existing.length === 0 && Number(counts[0]?.['total']) >= MAX_PREFERENCES) {
            await conn.rollback();
            return reply.code(422).send({ error: 'invalid_preference', reason: 'too_many_preferences' });
          }
          if (preference === 'require' && Number(counts[0]?.['required']) >= MAX_REQUIRED) {
            await conn.rollback();
            return reply.code(422).send({ error: 'invalid_preference', reason: 'too_many_required' });
          }
          await conn.query(
            `INSERT INTO card_preferences (owner_user_id, card_id, preference) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE preference = VALUES(preference)`,
            [owner, cardId, preference],
          );
        }
        await conn.commit();
      } catch (err) {
        await conn.rollback().catch(() => undefined);
        throw err;
      } finally {
        conn.release();
      }
      request.log.info({ event: 'card_preference', userId: owner, preference }, 'kingdoms');
      return { preferences: await preferences(owner) };
    },
  );

  app.post('/kingdoms/draw', { onRequest: authenticate, schema: { body: drawBody } }, async (request, reply) => {
    const owner = userId(request);
    const body = request.body as {
      editions?: string[];
      minCost?: number;
      maxCost?: number;
      excludeTypes?: string[];
      lockedIds?: string[];
      count: number;
    };
    if (body.minCost !== undefined && body.maxCost !== undefined && body.minCost > body.maxCost) {
      return reply.code(422).send({ error: 'invalid_draw', reason: 'invalid_cost_range' });
    }

    const where = [drawPool.sql];
    const params: unknown[] = [...drawPool.params];
    where.push(
      `c.name_en NOT IN (SELECT b.name_en FROM card_preferences p JOIN cards b ON b.id = p.card_id
         WHERE p.owner_user_id = ? AND p.preference = 'ban')`,
    );
    params.push(owner);
    if (body.editions && body.editions.length > 0) {
      where.push('EXISTS (SELECT 1 FROM edition_cards ec WHERE ec.card_id = c.id AND ec.edition_id IN (?))');
      params.push(body.editions);
    }
    if (body.minCost !== undefined) {
      where.push('c.cost_coins >= ?');
      params.push(body.minCost);
    }
    if (body.maxCost !== undefined) {
      where.push('c.cost_coins <= ?');
      params.push(body.maxCost);
    }
    if (body.excludeTypes && body.excludeTypes.length > 0) {
      where.push('NOT EXISTS (SELECT 1 FROM card_types tx WHERE tx.card_id = c.id AND tx.type IN (?))');
      params.push(body.excludeTypes);
    }
    const [poolRows] = await pool.query<RowDataPacket[]>(`SELECT c.id, c.name_en FROM cards c WHERE ${where.join(' AND ')}`, params);

    const [requiredRows] = await pool.query<RowDataPacket[]>(
      "SELECT card_id FROM card_preferences WHERE owner_user_id = ? AND preference = 'require'",
      [owner],
    );
    const lockedIds = [...new Set(body.lockedIds ?? [])];
    const fixedIds = [...new Set([...lockedIds, ...requiredRows.map((r) => String(r['card_id']))])];
    let fixed: DrawCard[] = [];
    if (fixedIds.length > 0) {
      const [fixedRows] = await pool.query<RowDataPacket[]>(
        `SELECT c.id, c.name_en FROM cards c WHERE c.id IN (?) AND ${playable.sql}`,
        [fixedIds, ...playable.params],
      );
      fixed = fixedRows.map((r) => ({ id: String(r['id']), nameEn: String(r['name_en']) }));
      const missingLocked = lockedIds.filter((id) => !fixed.some((card) => card.id === id));
      if (missingLocked.length > 0) {
        return reply.code(422).send({ error: 'invalid_draw', reason: 'not_a_supply_card' });
      }
    }

    const result = drawCards(
      poolRows.map((r) => ({ id: String(r['id']), nameEn: String(r['name_en']) })),
      fixed,
      body.count,
      () => randomInt(0, 2 ** 32) / 2 ** 32,
    );
    if (!result.ok) {
      return reply.code(422).send({ error: 'invalid_draw', reason: result.reason });
    }
    reply.header('Cache-Control', 'no-store');
    return { items: await cardViews(result.cards.map((c) => c.id)), fixedIds: fixed.map((c) => c.id) };
  });

  app.get('/kingdoms', { onRequest: authenticate }, async (request, reply) => {
    const owner = userId(request);
    const [kingdoms] = await pool.query<RowDataPacket[]>(
      'SELECT id, name, created_at FROM kingdoms WHERE owner_user_id = ? ORDER BY name, id',
      [owner],
    );
    const cards = new Map<string, string[]>();
    if (kingdoms.length > 0) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT kc.kingdom_id, c.name_en FROM kingdom_cards kc JOIN cards c ON c.id = kc.card_id
          WHERE kc.kingdom_id IN (?) ORDER BY kc.kingdom_id, kc.position`,
        [kingdoms.map((k) => k['id'])],
      );
      for (const r of rows) {
        const list = cards.get(String(r['kingdom_id'])) ?? [];
        list.push(String(r['name_en']));
        cards.set(String(r['kingdom_id']), list);
      }
    }
    reply.header('Cache-Control', 'no-store');
    return {
      kingdoms: kingdoms.map((k) => ({
        id: String(k['id']),
        name: String(k['name']),
        createdAt: (k['created_at'] as Date).toISOString(),
        cardNames: cards.get(String(k['id'])) ?? [],
      })),
    };
  });

  app.get('/kingdoms/:id', { onRequest: authenticate, schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const [found] = await pool.query<RowDataPacket[]>(
      'SELECT id, name, created_at FROM kingdoms WHERE id = ? AND owner_user_id = ?',
      [id, userId(request)],
    );
    const kingdom = found[0];
    if (!kingdom) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const [links] = await pool.query<RowDataPacket[]>('SELECT card_id FROM kingdom_cards WHERE kingdom_id = ?', [id]);
    reply.header('Cache-Control', 'no-store');
    return {
      id,
      name: String(kingdom['name']),
      createdAt: (kingdom['created_at'] as Date).toISOString(),
      items: await cardViews(links.map((l) => String(l['card_id']))),
    };
  });

  app.post('/kingdoms', { onRequest: authenticate, schema: { body: saveBody } }, async (request, reply) => {
    const owner = userId(request);
    const body = request.body as { name: string; cardIds: string[] };
    const name = cleanName(body.name);
    if (name === null) {
      return reply.code(422).send({ error: 'invalid_kingdom', reason: 'invalid_name' });
    }
    if (new Set(body.cardIds).size !== body.cardIds.length) {
      return reply.code(422).send({ error: 'invalid_kingdom', reason: 'duplicate_card' });
    }
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT c.id, c.name_en FROM cards c WHERE c.id IN (?) AND ${playable.sql}`,
      [body.cardIds, ...playable.params],
    );
    if (rows.length !== body.cardIds.length) {
      return reply.code(422).send({ error: 'invalid_kingdom', reason: 'not_a_supply_card' });
    }
    if (new Set(rows.map((r) => String(r['name_en']))).size !== rows.length) {
      return reply.code(422).send({ error: 'invalid_kingdom', reason: 'duplicate_card' });
    }

    const id = randomUUID();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('SELECT id FROM users WHERE id = ? FOR UPDATE', [owner]);
      const [count] = await conn.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM kingdoms WHERE owner_user_id = ?', [owner]);
      if (Number(count[0]?.['n']) >= MAX_KINGDOMS) {
        await conn.rollback();
        return reply.code(422).send({ error: 'invalid_kingdom', reason: 'too_many_kingdoms' });
      }
      await conn.query('INSERT INTO kingdoms (id, owner_user_id, name) VALUES (?, ?, ?)', [id, owner, name]);
      await conn.query('INSERT INTO kingdom_cards (kingdom_id, card_id, position) VALUES ?', [
        body.cardIds.map((cardId, position) => [id, cardId, position]),
      ]);
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => undefined);
      if (isDuplicate(err)) {
        return reply.code(409).send({ error: 'name_taken' });
      }
      throw err;
    } finally {
      conn.release();
    }
    request.log.info({ event: 'kingdom_saved', userId: owner, kingdomId: id }, 'kingdoms');
    return reply.code(201).send({ id, name, items: await cardViews(body.cardIds) });
  });

  app.delete('/kingdoms/:id', { onRequest: authenticate, schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const [result] = await pool.query<ResultSetHeader>(
      'DELETE FROM kingdoms WHERE id = ? AND owner_user_id = ?',
      [id, userId(request)],
    );
    if (result.affectedRows !== 1) {
      return reply.code(404).send({ error: 'not_found' });
    }
    request.log.info({ event: 'kingdom_deleted', userId: userId(request), kingdomId: id }, 'kingdoms');
    return reply.code(204).send();
  });
}
