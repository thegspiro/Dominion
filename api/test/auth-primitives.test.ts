import { describe, expect, it } from 'vitest';
import { parseCookies, serializeCookie } from '../src/auth/cookies.js';
import { getDummyHash, hashPassword, verifyPassword } from '../src/auth/password.js';
import { RateLimiter } from '../src/auth/rateLimit.js';
import { generateToken, hashToken, safeEqual } from '../src/auth/tokens.js';

describe('tokens', () => {
  it('generates unique 43-character url-safe tokens', () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(a);
  });

  it('hashes deterministically to 64 hex characters', () => {
    expect(hashToken('x')).toBe(hashToken('x'));
    expect(hashToken('x')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('x')).not.toBe(hashToken('y'));
  });

  it('compares strings safely including different lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('cookies', () => {
  it('parses a cookie header and ignores malformed parts', () => {
    expect(parseCookies('a=1; b=hello%20world; =x; c')).toEqual({ a: '1', b: 'hello world' });
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('bad=%E0%A4%A')).toEqual({});
  });

  it('serialises with security attributes', () => {
    const secure = serializeCookie('s', 'v', { maxAgeSeconds: 60, secure: true });
    expect(secure).toBe('s=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure');
    expect(serializeCookie('s', 'v', { maxAgeSeconds: 0, secure: false })).not.toContain('Secure');
  });
});

describe('password hashing', () => {
  it('produces an argon2id hash that verifies only the right password', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hash, 'wrong password!!')).toBe(false);
  });

  it('returns false for a malformed stored hash', async () => {
    expect(await verifyPassword('not-a-hash', 'whatever-password')).toBe(false);
  });

  it('provides a reusable dummy hash', async () => {
    expect(await getDummyHash()).toBe(await getDummyHash());
  });
});

describe('RateLimiter', () => {
  it('blocks after the limit and releases after the window', () => {
    let now = 1000;
    const limiter = new RateLimiter(3, 60_000, () => now);
    limiter.recordFailure('k');
    limiter.recordFailure('k');
    expect(limiter.retryAfterSeconds('k')).toBe(0);
    limiter.recordFailure('k');
    expect(limiter.retryAfterSeconds('k')).toBe(60);
    now += 61_000;
    expect(limiter.retryAfterSeconds('k')).toBe(0);
  });

  it('resets a key and isolates keys', () => {
    const limiter = new RateLimiter(1, 60_000);
    limiter.recordFailure('a');
    expect(limiter.retryAfterSeconds('a')).toBeGreaterThan(0);
    expect(limiter.retryAfterSeconds('b')).toBe(0);
    limiter.reset('a');
    expect(limiter.retryAfterSeconds('a')).toBe(0);
  });
});
