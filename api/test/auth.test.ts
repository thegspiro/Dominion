import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { SESSION_COOKIE } from '../src/auth/routes.js';
import { applyMigrations } from '../src/migrate.js';
import { resetDatabase } from './helpers/db.js';

const dbHost = process.env['TEST_DB_HOST'];
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/migrations');
const SETUP_TOKEN = 'test-setup-token-1234';
const PASSWORD = 'correct horse battery';

describe.skipIf(!dbHost)('auth routes against MySQL', () => {
  let pool: mysql.Pool;
  let app: FastifyInstance;

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
    await applyMigrations(pool, migrationsDir, { info: () => undefined });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      'SET FOREIGN_KEY_CHECKS = 0; TRUNCATE password_resets; TRUNCATE invites; TRUNCATE sessions; TRUNCATE users; SET FOREIGN_KEY_CHECKS = 1',
    );
    app = buildApp(
      {
        pool,
        simUrl: 'http://sim',
        auth: { pool, setupToken: SETUP_TOKEN, cookieSecure: true, limits: { perIp: 30, perUser: 3 } },
      },
      false,
    );
  });

  const cookieFrom = (res: { headers: Record<string, unknown> }): string => {
    const raw = res.headers['set-cookie'];
    const header = Array.isArray(raw) ? String(raw[0]) : String(raw);
    return header.split(';')[0] ?? '';
  };

  async function setupAdmin(): Promise<{ cookie: string; csrf: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/setup',
      payload: { setupToken: SETUP_TOKEN, username: 'admin', password: PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    return { cookie: cookieFrom(res), csrf: res.json().csrfToken };
  }

  async function createInvite(admin: { cookie: string; csrf: string }): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/invites',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
    });
    expect(res.statusCode).toBe(201);
    return res.json().token;
  }

  describe('first-run setup', () => {
    it('reports setup is required when there are no users', async () => {
      const res = await app.inject('/auth/status');
      expect(res.json()).toEqual({ setupRequired: true, setupConfigured: true });
    });

    it('rejects a wrong setup token and creates no user', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/setup',
        payload: { setupToken: 'wrong-token-wrong-token', username: 'admin', password: PASSWORD },
      });
      expect(res.statusCode).toBe(403);
      expect((await app.inject('/auth/status')).json().setupRequired).toBe(true);
    });

    it('creates the admin with a hashed password and an httpOnly session cookie', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/setup',
        payload: { setupToken: SETUP_TOKEN, username: 'admin', password: PASSWORD },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().user).toMatchObject({ username: 'admin', role: 'admin' });
      const setCookie = String(res.headers['set-cookie']);
      expect(setCookie).toContain(`${SESSION_COOKIE}=`);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Lax');
      expect(setCookie).toContain('Secure');

      const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT password_hash FROM users');
      expect(String(rows[0]?.['password_hash'])).toMatch(/^\$argon2id\$/);
      expect(JSON.stringify(rows)).not.toContain(PASSWORD);
    });

    it('stores only a hash of the session token', async () => {
      const admin = await setupAdmin();
      const token = decodeURIComponent(admin.cookie.split('=')[1] ?? '');
      const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT id FROM sessions');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.['id']).not.toBe(token);
      expect(String(rows[0]?.['id'])).toMatch(/^[0-9a-f]{64}$/);
    });

    it('disappears (404) once a user exists', async () => {
      await setupAdmin();
      const res = await app.inject({
        method: 'POST',
        url: '/auth/setup',
        payload: { setupToken: SETUP_TOKEN, username: 'second', password: PASSWORD },
      });
      expect(res.statusCode).toBe(404);
      expect((await app.inject('/auth/status')).json().setupRequired).toBe(false);
    });

    it('lets only one of several concurrent setups succeed', async () => {
      const attempt = (name: string) =>
        app.inject({
          method: 'POST',
          url: '/auth/setup',
          payload: { setupToken: SETUP_TOKEN, username: name, password: PASSWORD },
        });
      const results = await Promise.all([attempt('one'), attempt('two'), attempt('three')]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 404, 404]);
      const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS n FROM users');
      expect(rows[0]?.['n']).toBe(1);
    });

    it('is unavailable when no setup token is configured', async () => {
      const unconfigured = buildApp(
        { pool, simUrl: 'http://sim', auth: { pool, setupToken: undefined, cookieSecure: true } },
        false,
      );
      const res = await unconfigured.inject({
        method: 'POST',
        url: '/auth/setup',
        payload: { setupToken: 'anything-at-all-here', username: 'admin', password: PASSWORD },
      });
      expect(res.statusCode).toBe(503);
    });

    it('validates username and password', async () => {
      const bad = (payload: object) =>
        app.inject({ method: 'POST', url: '/auth/setup', payload: { setupToken: SETUP_TOKEN, ...payload } });
      expect((await bad({ username: 'a b', password: PASSWORD })).statusCode).toBe(400);
      expect((await bad({ username: 'ab', password: PASSWORD })).statusCode).toBe(400);
      expect((await bad({ username: 'admin', password: 'short' })).statusCode).toBe(400);
      expect((await bad({ username: "x'; DROP TABLE users;--", password: PASSWORD })).statusCode).toBe(400);
    });
  });

  describe('login, session and logout', () => {
    it('logs in, returns the user via /auth/me, and logs out', async () => {
      await setupAdmin();
      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { username: 'ADMIN', password: PASSWORD },
      });
      expect(login.statusCode).toBe(200);
      const cookie = cookieFrom(login);
      const csrf = login.json().csrfToken as string;

      const me = await app.inject({ url: '/auth/me', headers: { cookie } });
      expect(me.statusCode).toBe(200);
      expect(me.json().user).toMatchObject({ username: 'admin', role: 'admin' });

      const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie, 'x-csrf-token': csrf } });
      expect(logout.statusCode).toBe(204);
      expect((await app.inject({ url: '/auth/me', headers: { cookie } })).statusCode).toBe(401);
    });

    it('returns the same error for a wrong password and an unknown user', async () => {
      await setupAdmin();
      const wrongPassword = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { username: 'admin', password: 'not-the-password' },
      });
      const unknownUser = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { username: 'nobody', password: 'not-the-password' },
      });
      expect(wrongPassword.statusCode).toBe(401);
      expect(unknownUser.statusCode).toBe(401);
      expect(wrongPassword.json()).toEqual(unknownUser.json());
    });

    it('rate limits repeated failures for one username', async () => {
      await setupAdmin();
      const fail = () =>
        app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'admin', password: 'wrong-password' } });
      for (let i = 0; i < 3; i += 1) {
        expect((await fail()).statusCode).toBe(401);
      }
      const blocked = await fail();
      expect(blocked.statusCode).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      const correct = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'admin', password: PASSWORD } });
      expect(correct.statusCode).toBe(429);
    });

    it('answers 401 before looking at the body when nobody is signed in', async () => {
      const res = await app.inject({ method: 'POST', url: '/auth/invites', payload: { junk: true } });
      expect(res.statusCode).toBe(401);
    });

    it('rejects requests without a session, with a bogus session, and with an expired session', async () => {
      const admin = await setupAdmin();
      expect((await app.inject('/auth/me')).statusCode).toBe(401);
      expect((await app.inject({ url: '/auth/me', headers: { cookie: `${SESSION_COOKIE}=bogus` } })).statusCode).toBe(401);
      await pool.query('UPDATE sessions SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE)');
      expect((await app.inject({ url: '/auth/me', headers: { cookie: admin.cookie } })).statusCode).toBe(401);
    });

    it('slides the expiry for a session that has not been seen recently', async () => {
      const admin = await setupAdmin();
      await pool.query(
        'UPDATE sessions SET last_seen_at = DATE_SUB(NOW(), INTERVAL 2 HOUR), expires_at = DATE_ADD(NOW(), INTERVAL 1 DAY)',
      );
      const res = await app.inject({ url: '/auth/me', headers: { cookie: admin.cookie } });
      expect(res.statusCode).toBe(200);
      expect(String(res.headers['set-cookie'])).toContain('Max-Age=2592000');
      const [rows] = await pool.query<mysql.RowDataPacket[]>(
        'SELECT expires_at > DATE_ADD(NOW(), INTERVAL 29 DAY) AS extended FROM sessions',
      );
      expect(rows[0]?.['extended']).toBe(1);
    });

    it('rejects unexpected fields instead of ignoring them', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { username: 'admin', password: PASSWORD, role: 'admin' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('requires JSON bodies for login so cross-site form posts are refused', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'username=admin&password=whatever',
      });
      expect(res.statusCode).toBe(415);
    });
  });

  describe('csrf protection', () => {
    it('rejects authenticated state-changing requests without a valid token', async () => {
      const admin = await setupAdmin();
      const missing = await app.inject({ method: 'POST', url: '/auth/invites', headers: { cookie: admin.cookie } });
      expect(missing.statusCode).toBe(403);
      const wrong = await app.inject({
        method: 'POST',
        url: '/auth/invites',
        headers: { cookie: admin.cookie, 'x-csrf-token': 'x'.repeat(43) },
      });
      expect(wrong.statusCode).toBe(403);
      const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS n FROM invites');
      expect(rows[0]?.['n']).toBe(0);
    });
  });

  describe('invites', () => {
    it('lets an admin create an invite that a friend redeems exactly once', async () => {
      const admin = await setupAdmin();
      const token = await createInvite(admin);

      const [stored] = await pool.query<mysql.RowDataPacket[]>('SELECT token_hash FROM invites');
      expect(stored[0]?.['token_hash']).not.toBe(token);

      const redeem = await app.inject({
        method: 'POST',
        url: '/auth/invites/redeem',
        payload: { token, username: 'friend', password: 'another good passphrase' },
      });
      expect(redeem.statusCode).toBe(201);
      expect(redeem.json().user).toMatchObject({ username: 'friend', role: 'user' });
      const friendCookie = cookieFrom(redeem);
      expect((await app.inject({ url: '/auth/me', headers: { cookie: friendCookie } })).json().user.role).toBe('user');

      const reuse = await app.inject({
        method: 'POST',
        url: '/auth/invites/redeem',
        payload: { token, username: 'friend2', password: 'another good passphrase' },
      });
      expect(reuse.statusCode).toBe(400);
      expect(reuse.json()).toEqual({ error: 'invalid_invite' });
    });

    it('lets only one of several concurrent redemptions win', async () => {
      const admin = await setupAdmin();
      const token = await createInvite(admin);
      const redeem = (name: string) =>
        app.inject({
          method: 'POST',
          url: '/auth/invites/redeem',
          payload: { token, username: name, password: 'another good passphrase' },
        });
      const results = await Promise.all([redeem('racer1'), redeem('racer2'), redeem('racer3')]);
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
      const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM users WHERE role = 'user'");
      expect(rows[0]?.['n']).toBe(1);
    });

    it('rejects expired and unknown invites', async () => {
      const admin = await setupAdmin();
      const token = await createInvite(admin);
      await pool.query('UPDATE invites SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE)');
      const expired = await app.inject({
        method: 'POST',
        url: '/auth/invites/redeem',
        payload: { token, username: 'friend', password: 'another good passphrase' },
      });
      expect(expired.statusCode).toBe(400);
      const unknown = await app.inject({
        method: 'POST',
        url: '/auth/invites/redeem',
        payload: { token: 'nope', username: 'friend', password: 'another good passphrase' },
      });
      expect(unknown.statusCode).toBe(400);
    });

    it('keeps the invite usable when the chosen username is taken', async () => {
      const admin = await setupAdmin();
      const token = await createInvite(admin);
      const taken = await app.inject({
        method: 'POST',
        url: '/auth/invites/redeem',
        payload: { token, username: 'Admin', password: 'another good passphrase' },
      });
      expect(taken.statusCode).toBe(409);
      const retry = await app.inject({
        method: 'POST',
        url: '/auth/invites/redeem',
        payload: { token, username: 'friend', password: 'another good passphrase' },
      });
      expect(retry.statusCode).toBe(201);
    });

    it('forbids non-admins from creating invites and requires login', async () => {
      const admin = await setupAdmin();
      const token = await createInvite(admin);
      const redeem = await app.inject({
        method: 'POST',
        url: '/auth/invites/redeem',
        payload: { token, username: 'friend', password: 'another good passphrase' },
      });
      const friend = { cookie: cookieFrom(redeem), csrf: redeem.json().csrfToken as string };
      const forbidden = await app.inject({
        method: 'POST',
        url: '/auth/invites',
        headers: { cookie: friend.cookie, 'x-csrf-token': friend.csrf },
      });
      expect(forbidden.statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/auth/invites' })).statusCode).toBe(401);
    });
  });
});
