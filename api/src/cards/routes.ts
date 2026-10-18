import type { FastifyInstance } from 'fastify';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { Authenticate } from '../auth/routes.js';

interface CardRow extends RowDataPacket {
  id: string;
  name_en: string;
  name_de: string;
  price: string;
  cost_coins: number | null;
  cost_potions: number;
  cost_debt: number;
  cost_variable: number;
  kingdom: number;
}

interface CardView {
  id: string;
  name: { en: string; de: string };
  cost: { price: string; coins: number | null; potions: number; debt: number; variable: boolean };
  kingdom: boolean;
  types: string[];
  editions: { id: string; name: string }[];
}

const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const CARD_COLUMNS =
  'c.id, c.name_en, c.name_de, c.price, c.cost_coins, c.cost_potions, c.cost_debt, c.cost_variable, c.kingdom';

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    q: { type: 'string', minLength: 1, maxLength: 64 },
    edition: { type: 'string', pattern: UUID_PATTERN },
    type: { type: 'string', minLength: 1, maxLength: 32 },
    minCost: { type: 'integer', minimum: 0, maximum: 99 },
    maxCost: { type: 'integer', minimum: 0, maximum: 99 },
    potion: { type: 'boolean' },
    kingdom: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    offset: { type: 'integer', minimum: 0, maximum: 100000, default: 0 },
  },
} as const;

/** Escapes LIKE wildcards so user input is matched literally. */
function likePattern(text: string): string {
  return `%${text.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;
}

async function describeCards(pool: Pool, rows: CardRow[]): Promise<CardView[]> {
  if (rows.length === 0) {
    return [];
  }
  const ids = rows.map((r) => r.id);
  const [typeRows] = await pool.query<RowDataPacket[]>(
    'SELECT card_id, type FROM card_types WHERE card_id IN (?) ORDER BY type',
    [ids],
  );
  const [editionRows] = await pool.query<RowDataPacket[]>(
    `SELECT ec.card_id, e.id, e.name_en FROM edition_cards ec JOIN editions e ON e.id = ec.edition_id
      WHERE ec.card_id IN (?) ORDER BY e.release_date = 'various', e.release_date, e.name_en`,
    [ids],
  );
  const types = new Map<string, string[]>();
  for (const r of typeRows) {
    const list = types.get(String(r['card_id'])) ?? [];
    list.push(String(r['type']));
    types.set(String(r['card_id']), list);
  }
  const editions = new Map<string, { id: string; name: string }[]>();
  for (const r of editionRows) {
    const list = editions.get(String(r['card_id'])) ?? [];
    list.push({ id: String(r['id']), name: String(r['name_en']) });
    editions.set(String(r['card_id']), list);
  }
  return rows.map((r) => ({
    id: r.id,
    name: { en: r.name_en, de: r.name_de },
    cost: {
      price: r.price,
      coins: r.cost_coins,
      potions: r.cost_potions,
      debt: r.cost_debt,
      variable: r.cost_variable === 1,
    },
    kingdom: r.kingdom === 1,
    types: types.get(r.id) ?? [],
    editions: editions.get(r.id) ?? [],
  }));
}

export function registerCards(app: FastifyInstance, options: { pool: Pool; authenticate: Authenticate }): void {
  const { pool, authenticate } = options;

  app.get('/editions', { preHandler: authenticate }, async () => {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT e.id, e.name_en, e.name_de, e.release_date, COUNT(ec.card_id) AS card_count
         FROM editions e LEFT JOIN edition_cards ec ON ec.edition_id = e.id
        GROUP BY e.id, e.name_en, e.name_de, e.release_date
        ORDER BY e.release_date = 'various', e.release_date, e.name_en`,
    );
    return {
      editions: rows.map((r) => ({
        id: String(r['id']),
        name: { en: String(r['name_en']), de: String(r['name_de']) },
        releaseDate: String(r['release_date']),
        cardCount: Number(r['card_count']),
      })),
    };
  });

  app.get('/card-types', { preHandler: authenticate }, async () => {
    const [rows] = await pool.query<RowDataPacket[]>('SELECT DISTINCT type FROM card_types ORDER BY type');
    return { types: rows.map((r) => String(r['type'])) };
  });

  app.get('/cards', { preHandler: authenticate, schema: { querystring: listQuery } }, async (request, reply) => {
    const query = request.query as {
      q?: string;
      edition?: string;
      type?: string;
      minCost?: number;
      maxCost?: number;
      potion?: boolean;
      kingdom?: boolean;
      limit: number;
      offset: number;
    };
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (query.q !== undefined) {
      where.push("(c.name_en LIKE ? ESCAPE '!' OR c.name_de LIKE ? ESCAPE '!')");
      params.push(likePattern(query.q), likePattern(query.q));
    }
    if (query.edition !== undefined) {
      where.push('EXISTS (SELECT 1 FROM edition_cards ec WHERE ec.card_id = c.id AND ec.edition_id = ?)');
      params.push(query.edition);
    }
    if (query.type !== undefined) {
      where.push('EXISTS (SELECT 1 FROM card_types ct WHERE ct.card_id = c.id AND ct.type = ?)');
      params.push(query.type);
    }
    if (query.minCost !== undefined) {
      where.push('c.cost_coins >= ?');
      params.push(query.minCost);
    }
    if (query.maxCost !== undefined) {
      where.push('c.cost_coins <= ?');
      params.push(query.maxCost);
    }
    if (query.potion !== undefined) {
      where.push(query.potion ? 'c.cost_potions > 0' : 'c.cost_potions = 0');
    }
    if (query.kingdom !== undefined) {
      where.push('c.kingdom = ?');
      params.push(query.kingdom ? 1 : 0);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const [counted] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM cards c ${clause}`, params);
    const [rows] = await pool.query<CardRow[]>(
      `SELECT ${CARD_COLUMNS} FROM cards c ${clause} ORDER BY c.name_en, c.id LIMIT ? OFFSET ?`,
      [...params, query.limit, query.offset],
    );
    reply.header('Cache-Control', 'private, max-age=60');
    return { total: Number(counted[0]?.['n'] ?? 0), limit: query.limit, offset: query.offset, items: await describeCards(pool, rows) };
  });

  app.get(
    '/cards/:id',
    {
      preHandler: authenticate,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID_PATTERN } } },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [rows] = await pool.query<CardRow[]>(`SELECT ${CARD_COLUMNS} FROM cards c WHERE c.id = ? LIMIT 1`, [id]);
      const [card] = await describeCards(pool, rows);
      if (!card) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return card;
    },
  );
}
