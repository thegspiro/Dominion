import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { registerAuth, type AuthOptions } from './auth/routes.js';
import { registerCards } from './cards/routes.js';

export interface AppDeps {
  pool: Pick<Pool, 'query'>;
  simUrl: string;
  fetchImpl?: typeof fetch;
  auth?: Omit<AuthOptions, 'pool'> & { pool: Pool };
  trustProxy?: boolean;
}

const CHECK_TIMEOUT_MS = 2000;

export function buildApp(deps: AppDeps, logger: boolean | object = true): FastifyInstance {
  const app = Fastify({
    logger,
    trustProxy: deps.trustProxy ?? false,
    ajv: { customOptions: { removeAdditional: false } },
  });
  const doFetch = deps.fetchImpl ?? fetch;

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (request, reply) => {
    const checks: Record<string, 'ok' | 'fail'> = { database: 'ok', sim: 'ok' };

    try {
      await deps.pool.query('SELECT 1');
    } catch (err) {
      request.log.error({ err }, 'database readiness check failed');
      checks['database'] = 'fail';
    }

    try {
      const res = await doFetch(`${deps.simUrl}/health`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
      if (!res.ok) {
        checks['sim'] = 'fail';
      }
    } catch (err) {
      request.log.error({ err }, 'sim readiness check failed');
      checks['sim'] = 'fail';
    }

    const ready = Object.values(checks).every((v) => v === 'ok');
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ok' : 'unavailable', checks });
  });

  if (deps.auth) {
    const { authenticate } = registerAuth(app, deps.auth);
    registerCards(app, { pool: deps.auth.pool, authenticate });
  }

  return app;
}
