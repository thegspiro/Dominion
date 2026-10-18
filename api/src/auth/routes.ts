import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { parseCookies, serializeCookie } from './cookies.js';
import { getDummyHash, hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, verifyPassword } from './password.js';
import { RateLimiter } from './rateLimit.js';
import {
  countUsers,
  createFirstAdmin,
  createInvite,
  createSession,
  deleteExpiredSessions,
  deleteSession,
  findUserByUsername,
  getSession,
  recordLogin,
  redeemInvite,
  touchSession,
  type AuthUser,
} from './store.js';
import { safeEqual } from './tokens.js';

export const SESSION_COOKIE = 'dominion_session';
export const SESSION_TTL_DAYS = 30;
export const INVITE_TTL_HOURS = 72;
const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const WINDOW_MS = 15 * 60 * 1000;

export interface AuthOptions {
  pool: Pool;
  setupToken: string | undefined;
  cookieSecure: boolean;
  limits?: { perIp: number; perUser: number };
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    sessionId: string | null;
    csrfToken: string | null;
  }
}

const USERNAME_PATTERN = '^[A-Za-z0-9_-]{3,32}$';

const credentialsBody = {
  type: 'object',
  required: ['username', 'password'],
  additionalProperties: false,
  properties: {
    username: { type: 'string', minLength: 1, maxLength: 32 },
    password: { type: 'string', minLength: 1, maxLength: MAX_PASSWORD_LENGTH },
  },
} as const;

const newAccountProps = {
  username: { type: 'string', pattern: USERNAME_PATTERN },
  password: { type: 'string', minLength: MIN_PASSWORD_LENGTH, maxLength: MAX_PASSWORD_LENGTH },
} as const;

export type Authenticate = (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined>;

export function registerAuth(app: FastifyInstance, options: AuthOptions): { authenticate: Authenticate } {
  const { pool } = options;
  const ipLimiter = new RateLimiter(options.limits?.perIp ?? 30, WINDOW_MS);
  const userLimiter = new RateLimiter(options.limits?.perUser ?? 8, WINDOW_MS);

  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/auth/')) {
      reply.header('Cache-Control', 'no-store');
    }
  });

  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);
  app.decorateRequest('csrfToken', null);

  const sessionCookie = (token: string, maxAgeSeconds: number): string =>
    serializeCookie(SESSION_COOKIE, token, { maxAgeSeconds, secure: options.cookieSecure });

  const startSession = async (reply: FastifyReply, userId: number): Promise<string> => {
    const { token, csrfToken } = await createSession(pool, userId, SESSION_TTL_DAYS);
    reply.header('Set-Cookie', sessionCookie(token, SESSION_TTL_DAYS * 86400));
    return csrfToken;
  };

  const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (!token) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const session = await getSession(pool, token);
    if (!session) {
      reply.header('Set-Cookie', sessionCookie('', 0));
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (!SAFE_METHODS.has(request.method)) {
      const sent = request.headers[CSRF_HEADER];
      if (typeof sent !== 'string' || !safeEqual(sent, session.csrfToken)) {
        return reply.code(403).send({ error: 'csrf_token_invalid' });
      }
    }
    if (session.stale) {
      await touchSession(pool, session.id, SESSION_TTL_DAYS);
      reply.header('Set-Cookie', sessionCookie(token, SESSION_TTL_DAYS * 86400));
    }
    request.user = session.user;
    request.sessionId = session.id;
    request.csrfToken = session.csrfToken;
    return undefined;
  };

  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    const denied = await authenticate(request, reply);
    if (denied) {
      return denied;
    }
    if (request.user?.role !== 'admin') {
      return reply.code(403).send({ error: 'forbidden' });
    }
    return undefined;
  };

  const tooMany = (reply: FastifyReply, retryAfter: number): FastifyReply =>
    reply.header('Retry-After', String(retryAfter)).code(429).send({ error: 'too_many_attempts' });

  app.get('/auth/status', async () => {
    const users = await countUsers(pool);
    return { setupRequired: users === 0, setupConfigured: options.setupToken !== undefined };
  });

  app.post(
    '/auth/setup',
    {
      schema: {
        body: {
          type: 'object',
          required: ['setupToken', 'username', 'password'],
          additionalProperties: false,
          properties: { setupToken: { type: 'string', minLength: 1, maxLength: 256 }, ...newAccountProps },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { setupToken: string; username: string; password: string };
      if ((await countUsers(pool)) > 0) {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (options.setupToken === undefined) {
        return reply.code(503).send({ error: 'setup_not_configured' });
      }
      const key = `setup:${request.ip}`;
      const retryAfter = ipLimiter.retryAfterSeconds(key);
      if (retryAfter > 0) {
        return tooMany(reply, retryAfter);
      }
      if (!safeEqual(body.setupToken, options.setupToken)) {
        ipLimiter.recordFailure(key);
        request.log.warn({ event: 'setup_failed', ip: request.ip }, 'auth');
        return reply.code(403).send({ error: 'invalid_setup_token' });
      }
      const user = await createFirstAdmin(pool, body.username, await hashPassword(body.password));
      if (!user) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const csrfToken = await startSession(reply, user.id);
      request.log.info({ event: 'setup_complete', userId: user.id }, 'auth');
      return reply.code(201).send({ user, csrfToken });
    },
  );

  app.post('/auth/login', { schema: { body: credentialsBody } }, async (request, reply) => {
    const body = request.body as { username: string; password: string };
    const ipKey = `ip:${request.ip}`;
    const userKey = `user:${body.username.toLowerCase()}`;
    const retryAfter = Math.max(ipLimiter.retryAfterSeconds(ipKey), userLimiter.retryAfterSeconds(userKey));
    if (retryAfter > 0) {
      request.log.warn({ event: 'login_rate_limited', ip: request.ip }, 'auth');
      return tooMany(reply, retryAfter);
    }

    const user = await findUserByUsername(pool, body.username);
    const valid = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), body.password);
    if (!user || !valid) {
      ipLimiter.recordFailure(ipKey);
      userLimiter.recordFailure(userKey);
      request.log.warn({ event: 'login_failed', ip: request.ip }, 'auth');
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    userLimiter.reset(userKey);
    await deleteExpiredSessions(pool);
    await recordLogin(pool, user.id);
    const csrfToken = await startSession(reply, user.id);
    request.log.info({ event: 'login_success', userId: user.id }, 'auth');
    return { user: { id: user.id, username: user.username, role: user.role }, csrfToken };
  });

  app.post('/auth/logout', { onRequest: authenticate }, async (request, reply) => {
    if (request.sessionId) {
      await deleteSession(pool, request.sessionId);
    }
    request.log.info({ event: 'logout', userId: request.user?.id }, 'auth');
    reply.header('Set-Cookie', sessionCookie('', 0));
    return reply.code(204).send();
  });

  app.get('/auth/me', { onRequest: authenticate }, async (request) => ({
    user: request.user,
    csrfToken: request.csrfToken,
  }));

  app.post('/auth/invites', { onRequest: requireAdmin }, async (request, reply) => {
    const adminId = request.user?.id;
    if (adminId === undefined) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const token = await createInvite(pool, adminId, INVITE_TTL_HOURS);
    request.log.info({ event: 'invite_created', userId: adminId }, 'auth');
    return reply.code(201).send({ token, expiresInHours: INVITE_TTL_HOURS });
  });

  app.post(
    '/auth/invites/redeem',
    {
      schema: {
        body: {
          type: 'object',
          required: ['token', 'username', 'password'],
          additionalProperties: false,
          properties: { token: { type: 'string', minLength: 1, maxLength: 128 }, ...newAccountProps },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { token: string; username: string; password: string };
      const key = `redeem:${request.ip}`;
      const retryAfter = ipLimiter.retryAfterSeconds(key);
      if (retryAfter > 0) {
        return tooMany(reply, retryAfter);
      }
      const result = await redeemInvite(pool, body.token, body.username, await hashPassword(body.password));
      if (result.status === 'invalid_invite') {
        ipLimiter.recordFailure(key);
        request.log.warn({ event: 'invite_invalid', ip: request.ip }, 'auth');
        return reply.code(400).send({ error: 'invalid_invite' });
      }
      if (result.status === 'username_taken') {
        return reply.code(409).send({ error: 'username_taken' });
      }
      const csrfToken = await startSession(reply, result.user.id);
      request.log.info({ event: 'invite_redeemed', userId: result.user.id }, 'auth');
      return reply.code(201).send({ user: result.user, csrfToken });
    },
  );

  return { authenticate };
}
