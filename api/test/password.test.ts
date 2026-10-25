import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createPasswordReset, findUserByUsername } from '../src/auth/store.js';
import { applyMigrations, rollbackLast } from '../src/migrate.js';
import { resetDatabase } from './helpers/db.js';

const dbHost = process.env['TEST_DB_HOST'];
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/migrations');
const silent = { info: () => undefined };
const SETUP_TOKEN = 'test-setup-token-1234';
const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'a brand new passphrase';

interface Session {
  cookie: string;
  csrf: string;
}

describe.skipIf(!dbHost)('changing and resetting passwords against MySQL', () => {
  let pool: mysql.Pool;
  let app: FastifyInstance;
  let admin: Session;
  let friendId: number;

  const cookieFrom = (res: { headers: Record<string, unknown> }): string => {
    const raw = res.headers['set-cookie'];
    return (Array.isArray(raw) ? String(raw[0]) : String(raw)).split(';')[0] ?? '';
  };

  const call = (session: Session | null, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      payload: payload as object | undefined,
      headers: session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {},
    });

  const login = async (username: string, password: string): Promise<{ status: number; session: Session | null }> => {
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } });
    return res.statusCode === 200 ? { status: 200, session: { cookie: cookieFrom(res), csrf: res.json().csrfToken } } : { status: res.statusCode, session: null };
  };

  const meStatus = async (session: Session): Promise<number> => (await call(session, 'GET', '/auth/me')).statusCode;

  const lastToken = async (userId: number): Promise<string | undefined> => {
    const [rows] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?', [userId]);
    return rows.length > 0 ? String(rows[0]?.['n']) : undefined;
  };

  const newReset = async (userId: number): Promise<string> => {
    const res = await call(admin, 'POST', `/auth/users/${userId}/password-reset`);
    expect(res.statusCode, res.body).toBe(201);
    return res.json().token as string;
  };

  const redeem = (token: string, password = NEW_PASSWORD) =>
    app.inject({ method: 'POST', url: '/auth/password-reset/redeem', payload: { token, password } });

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
    await applyMigrations(pool, migrationsDir, silent);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      'SET FOREIGN_KEY_CHECKS = 0; TRUNCATE password_resets; TRUNCATE invites; TRUNCATE sessions; TRUNCATE users; SET FOREIGN_KEY_CHECKS = 1',
    );
    app = buildApp(
      { pool, simUrl: 'http://sim', auth: { pool, setupToken: SETUP_TOKEN, cookieSecure: true, limits: { perIp: 4, perUser: 3 } } },
      false,
    );
    const setup = await app.inject({
      method: 'POST',
      url: '/auth/setup',
      payload: { setupToken: SETUP_TOKEN, username: 'admin', password: PASSWORD },
    });
    admin = { cookie: cookieFrom(setup), csrf: setup.json().csrfToken };
    const invite = await call(admin, 'POST', '/auth/invites');
    const redeemInvite = await app.inject({
      method: 'POST',
      url: '/auth/invites/redeem',
      payload: { token: invite.json().token, username: 'friend', password: PASSWORD },
    });
    friendId = redeemInvite.json().user.id;
  });

  describe('changing your own password', () => {
    it('needs a session and the CSRF token', async () => {
      const body = { currentPassword: PASSWORD, newPassword: NEW_PASSWORD };
      expect((await call(null, 'POST', '/auth/password', body)).statusCode).toBe(401);
      const noCsrf = await app.inject({ method: 'POST', url: '/auth/password', payload: body, headers: { cookie: admin.cookie } });
      expect(noCsrf.statusCode).toBe(403);
      expect((await login('admin', PASSWORD)).status).toBe(200);
    });

    it.each([
      ['a short new password', { currentPassword: PASSWORD, newPassword: 'short' }],
      ['a very long new password', { currentPassword: PASSWORD, newPassword: 'x'.repeat(129) }],
      ['no current password', { newPassword: NEW_PASSWORD }],
      ['an empty current password', { currentPassword: '', newPassword: NEW_PASSWORD }],
      ['no new password', { currentPassword: PASSWORD }],
      ['an unknown field', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, role: 'admin' }],
    ])('rejects %s with 400', async (_name, payload) => {
      expect((await call(admin, 'POST', '/auth/password', payload)).statusCode).toBe(400);
    });

    it('refuses a wrong current password, then locks after repeated failures', async () => {
      for (let i = 0; i < 3; i += 1) {
        const res = await call(admin, 'POST', '/auth/password', { currentPassword: 'not my password', newPassword: NEW_PASSWORD });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: 'invalid_current_password' });
      }
      const locked = await call(admin, 'POST', '/auth/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      expect(locked.statusCode).toBe(429);
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
      expect((await login('admin', PASSWORD)).status).toBe(200);
    });

    it('refuses a new password that is the same as the old one', async () => {
      const res = await call(admin, 'POST', '/auth/password', { currentPassword: PASSWORD, newPassword: PASSWORD });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({ error: 'password_unchanged' });
    });

    it('changes the password, keeps this session and ends the others', async () => {
      const other = (await login('admin', PASSWORD)).session as Session;
      expect(await meStatus(other)).toBe(200);

      const res = await call(admin, 'POST', '/auth/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      expect(res.statusCode).toBe(204);
      expect(res.headers['cache-control']).toBe('no-store');

      expect(await meStatus(admin)).toBe(200);
      expect(await meStatus(other)).toBe(401);
      expect((await login('admin', PASSWORD)).status).toBe(401);
      expect((await login('admin', NEW_PASSWORD)).status).toBe(200);
      const stored = await findUserByUsername(pool, 'admin');
      expect(stored?.passwordHash).toMatch(/^\$argon2id\$/);
      expect(stored?.passwordHash).not.toContain(NEW_PASSWORD);
    });

    it("does not touch other people's sessions", async () => {
      const friend = (await login('friend', PASSWORD)).session as Session;
      await call(admin, 'POST', '/auth/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      expect(await meStatus(friend)).toBe(200);
    });
  });

  describe('listing accounts', () => {
    it('is for administrators only and never includes password data', async () => {
      const friend = (await login('friend', PASSWORD)).session as Session;
      expect((await call(null, 'GET', '/auth/users')).statusCode).toBe(401);
      expect((await call(friend, 'GET', '/auth/users')).statusCode).toBe(403);
      const res = await call(admin, 'GET', '/auth/users');
      expect(res.statusCode).toBe(200);
      const users = res.json().users as Record<string, unknown>[];
      expect(users.map((u) => [u['username'], u['role']])).toEqual([['admin', 'admin'], ['friend', 'user']]);
      expect(Number.isNaN(Date.parse(String(users[0]?.['createdAt'])))).toBe(false);
      expect(users[1]?.['lastLoginAt']).toBeTruthy();
      for (const user of users) {
        expect(Object.keys(user).sort()).toEqual(['createdAt', 'id', 'lastLoginAt', 'role', 'username']);
      }
    });
  });

  describe('making a reset link', () => {
    it('is for administrators only', async () => {
      const friend = (await login('friend', PASSWORD)).session as Session;
      expect((await call(null, 'POST', `/auth/users/${friendId}/password-reset`)).statusCode).toBe(401);
      expect((await call(friend, 'POST', `/auth/users/${friendId}/password-reset`)).statusCode).toBe(403);
      const noCsrf = await app.inject({ method: 'POST', url: `/auth/users/${friendId}/password-reset`, headers: { cookie: admin.cookie } });
      expect(noCsrf.statusCode).toBe(403);
      const [rows] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM password_resets');
      expect(Number(rows[0]?.['n'])).toBe(0);
    });

    it('rejects an unknown or malformed account id', async () => {
      expect((await call(admin, 'POST', '/auth/users/99999/password-reset')).statusCode).toBe(404);
      expect((await call(admin, 'POST', '/auth/users/0/password-reset')).statusCode).toBe(400);
      expect((await call(admin, 'POST', '/auth/users/abc/password-reset')).statusCode).toBe(400);
    });

    it('returns the link once and stores only its hash, for 24 hours', async () => {
      const res = await call(admin, 'POST', `/auth/users/${friendId}/password-reset`);
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({ expiresInHours: 24, username: 'friend' });
      expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT token_hash, created_by, TIMESTAMPDIFF(HOUR, NOW(), expires_at) AS hours FROM password_resets WHERE user_id = ?',
        [friendId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.['token_hash']).not.toBe(body.token);
      expect(String(rows[0]?.['token_hash'])).toMatch(/^[0-9a-f]{64}$/);
      expect(Number(rows[0]?.['created_by'])).toBeGreaterThan(0);
      expect([23, 24]).toContain(Number(rows[0]?.['hours']));
    });

    it('cancels an earlier link for the same person', async () => {
      const first = await newReset(friendId);
      const second = await newReset(friendId);
      expect((await redeem(first)).statusCode).toBe(400);
      expect((await redeem(second)).statusCode).toBe(204);
    });

    it('leaves other accounts links alone', async () => {
      const adminLink = await newReset(1);
      await newReset(friendId);
      expect((await redeem(adminLink)).statusCode).toBe(204);
    });
  });

  describe('using a reset link', () => {
    it('sets the new password and ends every session of that person', async () => {
      const phone = (await login('friend', PASSWORD)).session as Session;
      const laptop = (await login('friend', PASSWORD)).session as Session;
      const token = await newReset(friendId);

      const res = await redeem(token);
      expect(res.statusCode).toBe(204);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['set-cookie']).toBeUndefined();

      expect(await meStatus(phone)).toBe(401);
      expect(await meStatus(laptop)).toBe(401);
      expect(await meStatus(admin)).toBe(200);
      expect((await login('friend', PASSWORD)).status).toBe(401);
      expect((await login('friend', NEW_PASSWORD)).status).toBe(200);
    });

    it('works only once', async () => {
      const token = await newReset(friendId);
      expect((await redeem(token)).statusCode).toBe(204);
      const again = await redeem(token, 'yet another passphrase');
      expect(again.statusCode).toBe(400);
      expect(again.json()).toEqual({ error: 'invalid_reset' });
      expect((await login('friend', NEW_PASSWORD)).status).toBe(200);
    });

    it('refuses an expired link', async () => {
      const token = await newReset(friendId);
      await pool.query('UPDATE password_resets SET expires_at = DATE_SUB(NOW(), INTERVAL 1 HOUR)');
      const res = await redeem(token);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_reset' });
      expect((await login('friend', PASSWORD)).status).toBe(200);
    });

    it('gives the same answer for an unknown link', async () => {
      const res = await redeem('not-a-real-token');
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_reset' });
    });

    it('does not spend the link when the new password is rejected', async () => {
      const token = await newReset(friendId);
      expect((await redeem(token, 'short')).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/auth/password-reset/redeem', payload: { token, password: NEW_PASSWORD, extra: 1 } })).statusCode).toBe(400);
      expect((await redeem(token)).statusCode).toBe(204);
    });

    it('limits guessing by address', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        statuses.push((await redeem(`guess-${i}`)).statusCode);
      }
      expect(statuses).toEqual([400, 400, 400, 400, 429, 429]);
      const valid = await newReset(friendId);
      expect((await redeem(valid)).statusCode).toBe(429);
    });

    it('clears a login lock so the person can sign in straight away', async () => {
      for (let i = 0; i < 3; i += 1) {
        expect((await login('friend', 'wrong password!!')).status).toBe(401);
      }
      expect((await login('friend', PASSWORD)).status).toBe(429);
      const token = await newReset(friendId);
      expect((await redeem(token)).statusCode).toBe(204);
      expect((await login('friend', NEW_PASSWORD)).status).toBe(200);
    });

    it('works for a link made from the server, with no administrator recorded', async () => {
      const token = await createPasswordReset(pool, friendId, null, 24);
      const [rows] = await pool.query<RowDataPacket[]>('SELECT created_by FROM password_resets WHERE user_id = ?', [friendId]);
      expect(rows[0]?.['created_by']).toBeNull();
      expect((await redeem(token)).statusCode).toBe(204);
      expect((await login('friend', NEW_PASSWORD)).status).toBe(200);
    });

    it('is a different password check from the one for signing in', async () => {
      const token = await newReset(friendId);
      const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'friend', password: token } });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('the table', () => {
    it('is removed by the down migration and comes back on re-apply, without touching users', async () => {
      await newReset(friendId);
      expect(await rollbackLast(pool, migrationsDir, silent)).toBe('0006');
      const [gone] = await pool.query<RowDataPacket[]>("SHOW TABLES LIKE 'password_resets'");
      expect(gone).toHaveLength(0);
      const [users] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM users');
      expect(Number(users[0]?.['n'])).toBe(2);
      await applyMigrations(pool, migrationsDir, silent);
      const [back] = await pool.query<RowDataPacket[]>("SHOW TABLES LIKE 'password_resets'");
      expect(back).toHaveLength(1);
      expect(await lastToken(friendId)).toBe('0');
    });
  });
});
