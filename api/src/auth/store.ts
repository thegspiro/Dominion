import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { generateToken, hashToken } from './tokens.js';

export interface AuthUser {
  id: number;
  username: string;
  role: 'admin' | 'user';
}

export interface UserRecord extends AuthUser {
  passwordHash: string;
}

export interface SessionRecord {
  id: string;
  csrfToken: string;
  stale: boolean;
  user: AuthUser;
}

const SETUP_LOCK = 'dominion_setup';
const ER_DUP_ENTRY = 1062;

function isDuplicateEntry(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { errno?: number }).errno === ER_DUP_ENTRY;
}

function toUser(row: RowDataPacket): AuthUser {
  return { id: Number(row['id']), username: String(row['username']), role: row['role'] === 'admin' ? 'admin' : 'user' };
}

export async function countUsers(pool: Pool): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM users');
  return Number(rows[0]?.['n'] ?? 0);
}

export async function findUserByUsername(pool: Pool, username: string): Promise<UserRecord | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id, username, role, password_hash FROM users WHERE username = ? LIMIT 1',
    [username],
  );
  const row = rows[0];
  return row ? { ...toUser(row), passwordHash: String(row['password_hash']) } : null;
}

/**
 * Creates the first admin only if no user exists yet. Serialised with a named
 * lock so concurrent setup requests cannot both succeed. Returns null when a
 * user already exists.
 */
export async function createFirstAdmin(pool: Pool, username: string, passwordHash: string): Promise<AuthUser | null> {
  const conn = await pool.getConnection();
  try {
    const [lock] = await conn.query<RowDataPacket[]>('SELECT GET_LOCK(?, 10) AS acquired', [SETUP_LOCK]);
    if (lock[0]?.['acquired'] !== 1) {
      throw new Error('Could not acquire setup lock');
    }
    try {
      const [count] = await conn.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM users');
      if (Number(count[0]?.['n'] ?? 0) > 0) {
        return null;
      }
      const [result] = await conn.query<ResultSetHeader>(
        "INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')",
        [username, passwordHash],
      );
      return { id: result.insertId, username, role: 'admin' };
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [SETUP_LOCK]);
    }
  } finally {
    conn.release();
  }
}

export async function createSession(pool: Pool, userId: number, ttlDays: number): Promise<{ token: string; csrfToken: string }> {
  const token = generateToken();
  const csrfToken = generateToken();
  await pool.query(
    'INSERT INTO sessions (id, user_id, csrf_token, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))',
    [hashToken(token), userId, csrfToken, ttlDays],
  );
  return { token, csrfToken };
}

export async function getSession(pool: Pool, token: string): Promise<SessionRecord | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT s.id AS session_id, s.csrf_token, u.id, u.username, u.role,
            (s.last_seen_at < DATE_SUB(NOW(), INTERVAL 1 HOUR)) AS stale
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > NOW()
      LIMIT 1`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    id: String(row['session_id']),
    csrfToken: String(row['csrf_token']),
    stale: Number(row['stale']) === 1,
    user: toUser(row),
  };
}

export async function touchSession(pool: Pool, sessionId: string, ttlDays: number): Promise<void> {
  await pool.query(
    'UPDATE sessions SET last_seen_at = NOW(), expires_at = DATE_ADD(NOW(), INTERVAL ? DAY) WHERE id = ?',
    [ttlDays, sessionId],
  );
}

export async function deleteSession(pool: Pool, sessionId: string): Promise<void> {
  await pool.query('DELETE FROM sessions WHERE id = ?', [sessionId]);
}

export async function deleteExpiredSessions(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM sessions WHERE expires_at <= NOW()');
}

export async function recordLogin(pool: Pool, userId: number): Promise<void> {
  await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [userId]);
}

export async function createInvite(pool: Pool, adminId: number, ttlHours: number): Promise<string> {
  const token = generateToken();
  await pool.query(
    'INSERT INTO invites (token_hash, created_by, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))',
    [hashToken(token), adminId, ttlHours],
  );
  return token;
}

export type RedeemResult = { status: 'ok'; user: AuthUser } | { status: 'invalid_invite' } | { status: 'username_taken' };

/**
 * Atomically claims a single-use invite and creates the user. If the username
 * is taken the claim is rolled back so the invite stays usable.
 */
export async function redeemInvite(pool: Pool, token: string, username: string, passwordHash: string): Promise<RedeemResult> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [claim] = await conn.query<ResultSetHeader>(
      'UPDATE invites SET used_at = NOW() WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()',
      [hashToken(token)],
    );
    if (claim.affectedRows !== 1) {
      await conn.rollback();
      return { status: 'invalid_invite' };
    }
    let userId: number;
    try {
      const [created] = await conn.query<ResultSetHeader>(
        "INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'user')",
        [username, passwordHash],
      );
      userId = created.insertId;
    } catch (err) {
      await conn.rollback();
      if (isDuplicateEntry(err)) {
        return { status: 'username_taken' };
      }
      throw err;
    }
    await conn.query('UPDATE invites SET used_by = ? WHERE token_hash = ?', [userId, hashToken(token)]);
    await conn.commit();
    return { status: 'ok', user: { id: userId, username, role: 'user' } };
  } catch (err) {
    await conn.rollback().catch(() => undefined);
    throw err;
  } finally {
    conn.release();
  }
}

export interface UserSummary extends AuthUser {
  createdAt: string;
  lastLoginAt: string | null;
}

export async function listUsers(pool: Pool): Promise<UserSummary[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, username, role, UNIX_TIMESTAMP(created_at) AS created, UNIX_TIMESTAMP(last_login_at) AS last_login
       FROM users ORDER BY username`,
  );
  return rows.map((row) => ({
    ...toUser(row),
    createdAt: new Date(Number(row['created']) * 1000).toISOString(),
    lastLoginAt: row['last_login'] === null ? null : new Date(Number(row['last_login']) * 1000).toISOString(),
  }));
}

export async function findUserById(pool: Pool, id: number): Promise<AuthUser | null> {
  const [rows] = await pool.query<RowDataPacket[]>('SELECT id, username, role FROM users WHERE id = ? LIMIT 1', [id]);
  const row = rows[0];
  return row ? toUser(row) : null;
}

/** Stores a new password hash and ends the user's other sessions, in one transaction. */
export async function changePassword(pool: Pool, userId: number, passwordHash: string, keepSessionId: string): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId]);
    await conn.query('DELETE FROM sessions WHERE user_id = ? AND id <> ?', [userId, keepSessionId]);
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => undefined);
    throw err;
  } finally {
    conn.release();
  }
}

/** Makes a single-use reset link for a user. Any earlier unused link for that user stops working. */
export async function createPasswordReset(pool: Pool, userId: number, createdBy: number | null, ttlHours: number): Promise<string> {
  const token = generateToken();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL', [userId]);
    await conn.query(
      'INSERT INTO password_resets (token_hash, user_id, created_by, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))',
      [hashToken(token), userId, createdBy, ttlHours],
    );
    await conn.commit();
    return token;
  } catch (err) {
    await conn.rollback().catch(() => undefined);
    throw err;
  } finally {
    conn.release();
  }
}

/** A cheap check that lets the caller skip hashing a password for a link that cannot work. */
export async function isPasswordResetUsable(pool: Pool, token: string): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT 1 AS ok FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1',
    [hashToken(token)],
  );
  return rows.length === 1;
}

export type PasswordResetResult = { status: 'ok'; user: AuthUser } | { status: 'invalid_reset' };

/**
 * Claims a single-use reset link, stores the new password hash and ends every session of that user, in one
 * transaction. The link is only spent when all of that succeeds.
 */
export async function redeemPasswordReset(pool: Pool, token: string, passwordHash: string): Promise<PasswordResetResult> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [claim] = await conn.query<ResultSetHeader>(
      'UPDATE password_resets SET used_at = NOW() WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()',
      [hashToken(token)],
    );
    if (claim.affectedRows !== 1) {
      await conn.rollback();
      return { status: 'invalid_reset' };
    }
    const [found] = await conn.query<RowDataPacket[]>(
      `SELECT u.id, u.username, u.role FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ? FOR UPDATE`,
      [hashToken(token)],
    );
    const row = found[0];
    if (!row) {
      await conn.rollback();
      return { status: 'invalid_reset' };
    }
    const user = toUser(row);
    await conn.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, user.id]);
    await conn.query('DELETE FROM sessions WHERE user_id = ?', [user.id]);
    await conn.commit();
    return { status: 'ok', user };
  } catch (err) {
    await conn.rollback().catch(() => undefined);
    throw err;
  } finally {
    conn.release();
  }
}
