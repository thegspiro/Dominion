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
