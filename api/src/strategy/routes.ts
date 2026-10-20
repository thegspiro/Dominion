import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Authenticate } from '../auth/routes.js';
import { RateLimiter } from '../auth/rateLimit.js';

const SIMULATE_TIMEOUT_MS = 30_000;
const LOOKUP_TIMEOUT_MS = 5_000;
const MAX_GAMES = 5000;
const MAX_SEED = 4_294_967_295;
const RUNS_PER_WINDOW = 6;
const WINDOW_MS = 60_000;

const strategyId = { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' } as const;

const simulateBody = {
  type: 'object',
  required: ['a', 'b', 'games'],
  additionalProperties: false,
  properties: {
    a: strategyId,
    b: strategyId,
    games: { type: 'integer', minimum: 1, maximum: MAX_GAMES },
    seed: { type: 'integer', minimum: 0, maximum: MAX_SEED },
  },
} as const;

interface SimulateBody {
  a: string;
  b: string;
  games: number;
  seed?: number;
}

export function registerStrategy(
  app: FastifyInstance,
  options: { simUrl: string; authenticate: Authenticate; fetchImpl?: typeof fetch; limits?: { runsPerWindow?: number } },
): void {
  const { simUrl, authenticate } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const limiter = new RateLimiter(options.limits?.runsPerWindow ?? RUNS_PER_WINDOW, WINDOW_MS);
  const running = new Set<number>();

  const userId = (request: { user: { id: number } | null }): number => {
    if (!request.user) {
      throw new Error('authenticate must run first');
    }
    return request.user.id;
  };

  /** Fetches JSON from the sim service and maps every failure to a clear status. */
  async function forward(
    reply: FastifyReply,
    path: string,
    init: RequestInit,
    timeoutMs: number,
    log: FastifyInstance['log'],
  ): Promise<FastifyReply> {
    let response: Response;
    try {
      response = await doFetch(`${simUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      log.error({ err, path }, 'sim request failed');
      return reply.code(timedOut ? 504 : 502).send({ error: timedOut ? 'sim_timeout' : 'sim_unavailable' });
    }
    if (response.status === 422) {
      return reply.code(400).send({ error: 'unknown_strategy' });
    }
    if (!response.ok) {
      log.error({ status: response.status, path }, 'sim returned an error');
      return reply.code(502).send({ error: 'sim_unavailable' });
    }
    return reply.code(200).header('Cache-Control', 'no-store').send(await response.json());
  }

  app.get('/strategy/strategies', { onRequest: authenticate }, async (request, reply) =>
    forward(reply, '/strategies', {}, LOOKUP_TIMEOUT_MS, request.log),
  );

  app.get('/strategy/odds', { onRequest: authenticate }, async (request, reply) =>
    forward(reply, '/odds/opening', {}, LOOKUP_TIMEOUT_MS, request.log),
  );

  app.post('/strategy/simulate', { onRequest: authenticate, schema: { body: simulateBody } }, async (request, reply) => {
    const owner = userId(request);
    const body = request.body as SimulateBody;
    const key = String(owner);

    const retryAfter = limiter.retryAfterSeconds(key);
    if (retryAfter > 0) {
      return reply.header('Retry-After', String(retryAfter)).code(429).send({ error: 'too_many_runs' });
    }
    if (running.has(owner)) {
      return reply.code(409).send({ error: 'run_in_progress' });
    }

    running.add(owner);
    limiter.recordFailure(key);
    const started = Date.now();
    try {
      const sent = await forward(
        reply,
        '/simulate',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ a: body.a, b: body.b, games: body.games, ...(body.seed === undefined ? {} : { seed: body.seed }) }),
        },
        SIMULATE_TIMEOUT_MS,
        request.log,
      );
      request.log.info(
        { userId: owner, a: body.a, b: body.b, games: body.games, status: reply.statusCode, ms: Date.now() - started },
        'strategy simulation',
      );
      return sent;
    } finally {
      running.delete(owner);
    }
  });
}
