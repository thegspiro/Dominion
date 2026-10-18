import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

const okPool = { query: async () => [[{ 1: 1 }], []] } as never;
const badPool = { query: async () => { throw new Error('down'); } } as never;
const okFetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
const badFetch = (async () => { throw new Error('refused'); }) as typeof fetch;

describe('health endpoints', () => {
  it('reports liveness without dependencies', async () => {
    const app = buildApp({ pool: badPool, simUrl: 'http://sim', fetchImpl: badFetch }, false);
    const res = await app.inject('/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('is ready when database and sim respond', async () => {
    const app = buildApp({ pool: okPool, simUrl: 'http://sim', fetchImpl: okFetch }, false);
    const res = await app.inject('/health/ready');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', checks: { database: 'ok', sim: 'ok' } });
  });

  it('returns 503 when the database is down', async () => {
    const app = buildApp({ pool: badPool, simUrl: 'http://sim', fetchImpl: okFetch }, false);
    const res = await app.inject('/health/ready');
    expect(res.statusCode).toBe(503);
    expect(res.json().checks).toEqual({ database: 'fail', sim: 'ok' });
  });

  it('returns 503 when sim is unreachable or unhealthy', async () => {
    const down = buildApp({ pool: okPool, simUrl: 'http://sim', fetchImpl: badFetch }, false);
    expect((await down.inject('/health/ready')).json().checks.sim).toBe('fail');

    const unhealthy = buildApp(
      { pool: okPool, simUrl: 'http://sim', fetchImpl: (async () => new Response('', { status: 500 })) as typeof fetch },
      false,
    );
    expect((await unhealthy.inject('/health/ready')).statusCode).toBe(503);
  });
});
