import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { Dataset } from './dataset.js';
import type { Logger } from '../migrate.js';

const LOCK_NAME = 'dominion_import_cards';
const LOCK_TIMEOUT_SECONDS = 60;

export interface ImportStats {
  editions: number;
  cards: number;
  cardTypes: number;
  editionCards: number;
  cardsNotInDataset: number;
}

/**
 * Loads the dataset into MySQL in one transaction. Safe to run repeatedly and
 * concurrently: rows are upserted by id and the type and edition links of the
 * imported cards are replaced. Cards that are in the database but no longer in
 * the dataset are left in place (later features may reference them) and counted.
 */
export async function importDataset(pool: Pool, dataset: Dataset, log: Logger): Promise<ImportStats> {
  const conn = await pool.getConnection();
  try {
    const [lock] = await conn.query<RowDataPacket[]>('SELECT GET_LOCK(?, ?) AS acquired', [
      LOCK_NAME,
      LOCK_TIMEOUT_SECONDS,
    ]);
    if (lock[0]?.['acquired'] !== 1) {
      throw new Error('Could not acquire the card import lock; another import may be running');
    }
    try {
      await conn.beginTransaction();

      await conn.query(
        `INSERT INTO editions (id, name_en, name_de, release_date) VALUES ?
         ON DUPLICATE KEY UPDATE name_en = VALUES(name_en), name_de = VALUES(name_de), release_date = VALUES(release_date)`,
        [dataset.editions.map((e) => [e.id, e.nameEn, e.nameDe, e.releaseDate])],
      );

      await conn.query(
        `INSERT INTO cards (id, name_en, name_de, price, cost_coins, cost_potions, cost_debt, cost_variable, kingdom) VALUES ?
         ON DUPLICATE KEY UPDATE name_en = VALUES(name_en), name_de = VALUES(name_de), price = VALUES(price),
           cost_coins = VALUES(cost_coins), cost_potions = VALUES(cost_potions), cost_debt = VALUES(cost_debt),
           cost_variable = VALUES(cost_variable), kingdom = VALUES(kingdom)`,
        [
          dataset.cards.map((c) => [
            c.id,
            c.nameEn,
            c.nameDe,
            c.price,
            c.cost.coins,
            c.cost.potions,
            c.cost.debt,
            c.cost.variable ? 1 : 0,
            c.kingdom ? 1 : 0,
          ]),
        ],
      );

      const cardIds = dataset.cards.map((c) => c.id);
      await conn.query('DELETE FROM card_types WHERE card_id IN (?)', [cardIds]);
      await conn.query('DELETE FROM edition_cards WHERE card_id IN (?)', [cardIds]);

      const typeRows = dataset.cards.flatMap((c) => c.types.map((type) => [c.id, type]));
      await conn.query('INSERT INTO card_types (card_id, type) VALUES ?', [typeRows]);

      const linkRows = dataset.editions.flatMap((e) => e.cardIds.map((cardId) => [e.id, cardId]));
      await conn.query('INSERT INTO edition_cards (edition_id, card_id) VALUES ?', [linkRows]);

      const [total] = await conn.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM cards');
      await conn.commit();

      const stats: ImportStats = {
        editions: dataset.editions.length,
        cards: dataset.cards.length,
        cardTypes: typeRows.length,
        editionCards: linkRows.length,
        cardsNotInDataset: Number(total[0]?.['n'] ?? 0) - dataset.cards.length,
      };
      log.info({ ...stats, corrections: dataset.appliedCorrections }, 'card import complete');
      return stats;
    } catch (err) {
      await conn.rollback().catch(() => undefined);
      throw err;
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
    }
  } finally {
    conn.release();
  }
}
