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
  };
}
