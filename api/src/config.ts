export interface Config {
  host: string;
  port: number;
  db: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
  };
  simUrl: string;
  migrationsDir: string;
  setupToken: string | undefined;
  cookieSecure: boolean;
  trustProxy: boolean;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${key}`);
  }
  return value;
}

function port(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Environment variable ${key} must be a port number, got "${raw}"`);
  }
  return value;
}

function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  throw new Error(`Environment variable ${key} must be "true" or "false", got "${raw}"`);
}

export const MIN_SETUP_TOKEN_LENGTH = 16;

function setupToken(env: NodeJS.ProcessEnv): string | undefined {
  const value = env['SETUP_TOKEN'];
  if (value === undefined || value === '') {
    return undefined;
  }
  if (value.length < MIN_SETUP_TOKEN_LENGTH) {
    throw new Error(`SETUP_TOKEN must be at least ${MIN_SETUP_TOKEN_LENGTH} characters`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env['API_HOST'] || '0.0.0.0',
    port: port(env, 'API_PORT', 3000),
    db: {
      host: required(env, 'DB_HOST'),
      port: port(env, 'DB_PORT', 3306),
      name: env['DB_NAME'] || 'dominion',
      user: required(env, 'DB_USER'),
      password: required(env, 'DB_PASSWORD'),
    },
    simUrl: env['SIM_URL'] || 'http://sim:8000',
    migrationsDir: env['MIGRATIONS_DIR'] || '/app/migrations',
    setupToken: setupToken(env),
    cookieSecure: bool(env, 'COOKIE_SECURE', true),
    trustProxy: bool(env, 'TRUST_PROXY', false),
  };
}
