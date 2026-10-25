import mysql from 'mysql2/promise';
import { PASSWORD_RESET_TTL_HOURS } from '../auth/routes.js';
import { createPasswordReset, findUserByUsername } from '../auth/store.js';
import { loadConfig } from '../config.js';

/** Makes a one-time reset link for an account from the server, for when no administrator can sign in. */
async function main(): Promise<void> {
  const username = process.argv[2];
  if (!username || process.argv.length > 3) {
    console.error('Usage: reset-password <username>');
    process.exit(2);
  }
  const config = loadConfig();
  const pool = mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.name,
    user: config.db.user,
    password: config.db.password,
    connectionLimit: 2,
    charset: 'utf8mb4',
  });
  try {
    const user = await findUserByUsername(pool, username);
    if (!user) {
      console.error(`No account named "${username}".`);
      process.exitCode = 1;
      return;
    }
    const token = await createPasswordReset(pool, user.id, null, PASSWORD_RESET_TTL_HOURS);
    console.log(`Reset link for ${user.username}: open /reset.html#${token} on your site.`);
    console.log(`It works once and expires in ${PASSWORD_RESET_TTL_HOURS} hours. Hand it over privately.`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
