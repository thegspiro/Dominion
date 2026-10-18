import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = { DB_HOST: 'db', DB_USER: 'u', DB_PASSWORD: 'p' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(base);
    expect(config.port).toBe(3000);
    expect(config.db.name).toBe('dominion');
    expect(config.db.port).toBe(3306);
    expect(config.simUrl).toBe('http://sim:8000');
  });

  it('requires database credentials', () => {
    expect(() => loadConfig({ DB_HOST: 'db', DB_USER: 'u' })).toThrow('DB_PASSWORD');
  });

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ ...base, API_PORT: 'abc' })).toThrow('API_PORT');
    expect(() => loadConfig({ ...base, DB_PORT: '70000' })).toThrow('DB_PORT');
  });
});

describe('loadConfig auth settings', () => {
  it('defaults to secure cookies, no proxy trust and no setup token', () => {
    const config = loadConfig(base);
    expect(config.cookieSecure).toBe(true);
    expect(config.trustProxy).toBe(false);
    expect(config.setupToken).toBeUndefined();
  });

  it('reads overrides', () => {
    const config = loadConfig({ ...base, COOKIE_SECURE: 'false', TRUST_PROXY: 'true', SETUP_TOKEN: 'a-long-enough-token' });
    expect(config.cookieSecure).toBe(false);
    expect(config.trustProxy).toBe(true);
    expect(config.setupToken).toBe('a-long-enough-token');
  });

  it('treats an empty SETUP_TOKEN as unset', () => {
    expect(loadConfig({ ...base, SETUP_TOKEN: '' }).setupToken).toBeUndefined();
  });

  it('rejects a short SETUP_TOKEN and non-boolean flags', () => {
    expect(() => loadConfig({ ...base, SETUP_TOKEN: 'short' })).toThrow('SETUP_TOKEN');
    expect(() => loadConfig({ ...base, COOKIE_SECURE: 'yes' })).toThrow('COOKIE_SECURE');
  });
});
