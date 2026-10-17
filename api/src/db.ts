import mysql from 'mysql2/promise';
import type { Config } from './config.js';

export function createPool(config: Config['db']): mysql.Pool {
  return mysql.createPool({
    host: config.host,
    port: config.port,
    database: config.name,
    user: config.user,
    password: config.password,
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4',
  });
}
