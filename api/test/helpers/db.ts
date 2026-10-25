import type { Pool } from 'mysql2/promise';

const TABLES = [
  'card_preferences',
  'kingdom_cards',
  'kingdoms',
  'game_events',
  'game_piles',
  'game_players',
  'games',
  'edition_cards',
  'card_types',
  'cards',
  'editions',
  'password_resets',
  'invites',
  'sessions',
  'users',
  'schema_migrations',
];

/** Drops every application table so a test can start from migration 0001. The pool needs multipleStatements. */
export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query(
    `SET FOREIGN_KEY_CHECKS = 0; DROP TABLE IF EXISTS ${TABLES.join(', ')}; SET FOREIGN_KEY_CHECKS = 1`,
  );
}
