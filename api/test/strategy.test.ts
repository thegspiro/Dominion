import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
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

interface SimCall {
  url: string;
  method: string;
  body: unknown;
}

const SIM_RESULT = { games: 10, seed: 4, a: { strategy: 'big_money', wins: 5 }, b: { strategy: 'big_money', wins: 5 }, ties: 0 };

describe.skipIf(!dbHost)('strategy lab API', () => {
  let pool: mysql.Pool;
  let app: FastifyInstance;
  let owner: Session;
  let friend: Session;
  let calls: SimCall[];
  let simBehaviour: (url: string) => Promise<Response>;

  const json = (body: unknown, status = 200): Promise<Response> =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    return simBehaviour(url);
  };

  const call = (session: Session | null, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      payload: payload as object | undefined,
      headers: session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {},
    });

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
    app = buildApp(
      { pool, simUrl: 'http://sim', fetchImpl: fakeFetch, auth: { pool, setupToken: SETUP_TOKEN, cookieSecure: true } },
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
    friend = { cookie: cookieOf(redeem), csrf: redeem.json().csrfToken };
  });

  beforeEach(() => {
    calls = [];
    simBehaviour = () => json(SIM_RESULT);
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('authentication', () => {
    it('refuses every route without a session', async () => {
      expect((await call(null, 'GET', '/strategy/strategies')).statusCode).toBe(401);
      expect((await call(null, 'GET', '/strategy/odds')).statusCode).toBe(401);
      expect((await call(null, 'POST', '/strategy/simulate', { a: 'big_money', b: 'big_money', games: 5 })).statusCode).toBe(401);
      expect(calls).toHaveLength(0);
    });

    it('requires the CSRF header on a run', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/strategy/simulate',
        payload: { a: 'big_money', b: 'big_money', games: 5 },
        headers: { cookie: owner.cookie },
      });
      expect(res.statusCode).toBe(403);
      expect(calls).toHaveLength(0);
    });
  });

  describe('lookups', () => {
    it('forwards the strategy list and the opening odds', async () => {
      simBehaviour = (url) => json({ from: url });
      const strategies = await call(owner, 'GET', '/strategy/strategies');
      expect(strategies.statusCode).toBe(200);
      expect(strategies.json()).toEqual({ from: 'http://sim/strategies' });
      const odds = await call(owner, 'GET', '/strategy/odds');
      expect(odds.json()).toEqual({ from: 'http://sim/odds/opening' });
    });

    it('answers 502 when the sim is down', async () => {
      simBehaviour = () => Promise.reject(new TypeError('fetch failed'));
      const res = await call(owner, 'GET', '/strategy/odds');
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'sim_unavailable' });
    });
  });

  describe('running a simulation', () => {
    it('forwards only validated fields and returns the result', async () => {
      const res = await call(owner, 'POST', '/strategy/simulate', { a: 'big_money', b: 'big_money_smithy', games: 10, seed: 4 });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual(SIM_RESULT);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(calls).toEqual([
        { url: 'http://sim/simulate', method: 'POST', body: { a: 'big_money', b: 'big_money_smithy', games: 10, seed: 4 } },
      ]);
    });

    it('leaves the seed out when none is given', async () => {
      await call(friend, 'POST', '/strategy/simulate', { a: 'big_money', b: 'big_money', games: 3 });
      expect(calls[0]?.body).toEqual({ a: 'big_money', b: 'big_money', games: 3 });
    });

    it.each([
      ['no games', { a: 'big_money', b: 'big_money' }],
      ['zero games', { a: 'big_money', b: 'big_money', games: 0 }],
      ['too many games', { a: 'big_money', b: 'big_money', games: 5001 }],
      ['fractional games', { a: 'big_money', b: 'big_money', games: 1.5 }],
      ['negative seed', { a: 'big_money', b: 'big_money', games: 5, seed: -1 }],
      ['oversized seed', { a: 'big_money', b: 'big_money', games: 5, seed: 4294967296 }],
      ['unknown field', { a: 'big_money', b: 'big_money', games: 5, extra: true }],
      ['odd strategy id', { a: '../etc/passwd', b: 'big_money', games: 5 }],
      ['uppercase id', { a: 'Big_Money', b: 'big_money', games: 5 }],
      ['non-numeric games', { a: 'big_money', b: 'big_money', games: 'five' }],
    ])('rejects %s with 400 before reaching the sim', async (_name, payload) => {
      const res = await call(friend, 'POST', '/strategy/simulate', payload);
      expect(res.statusCode).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it('maps an unknown strategy from the sim to 400', async () => {
      simBehaviour = () => json({ detail: 'unknown strategy' }, 422);
      const res = await call(owner, 'POST', '/strategy/simulate', { a: 'witch_rush', b: 'big_money', games: 5 });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'unknown_strategy' });
    });

    it('maps a sim failure to 502 and a timeout to 504', async () => {
      simBehaviour = () => json({}, 500);
      expect((await call(owner, 'POST', '/strategy/simulate', { a: 'big_money', b: 'big_money', games: 5 })).statusCode).toBe(502);
      simBehaviour = () => Promise.reject(new DOMException('timed out', 'TimeoutError'));
      const res = await call(owner, 'POST', '/strategy/simulate', { a: 'big_money', b: 'big_money', games: 5 });
      expect(res.statusCode).toBe(504);
      expect(res.json()).toEqual({ error: 'sim_timeout' });
    });

    it('allows only one run at a time per user', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      simBehaviour = async () => {
        await gate;
        return json(SIM_RESULT);
      };
      const payload = { a: 'big_money', b: 'big_money', games: 5 };
      const first = call(friend, 'POST', '/strategy/simulate', payload);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = await call(friend, 'POST', '/strategy/simulate', payload);
      expect(second.statusCode).toBe(409);
      expect(second.json()).toEqual({ error: 'run_in_progress' });
      release();
      expect((await first).statusCode).toBe(200);
      expect((await call(friend, 'POST', '/strategy/simulate', payload)).statusCode).toBe(200);
    });
  });

  describe('rate limit', () => {
    it('blocks a user after six runs a minute without affecting others', async () => {
      const payload = { a: 'big_money', b: 'big_money', games: 5 };
      const statuses: number[] = [];
      for (let i = 0; i < 8; i += 1) {
        const res = await call(owner, 'POST', '/strategy/simulate', payload);
        statuses.push(res.statusCode);
        if (res.statusCode === 429) {
          expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
          expect(res.json()).toEqual({ error: 'too_many_runs' });
        }
      }
      const ok = statuses.filter((s) => s === 200).length;
      expect(ok).toBeLessThanOrEqual(6);
      expect(statuses.at(-1)).toBe(429);
      expect((await call(friend, 'GET', '/strategy/odds')).statusCode).toBe(200);
    });
  });
});
