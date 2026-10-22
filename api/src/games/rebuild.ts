import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface RebuildLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
}

export interface ReplayResult {
  decks: Map<number, Record<string, number>>;
  skipped: number;
}

export interface RebuildSummary {
  games: number;
  rebuilt: number;
  skippedEvents: number;
}

const MAX_SEATS = 4;

/**
 * Works out each player's cards by replaying saved events. Events saved before decks were tracked do not name
 * who received a card, so a take or return counts for the player whose turn it was. Undone actions are not in
 * the log, so this replays the path the game actually took. Anything unreadable is skipped and counted.
 */
export function replayDecks(events: { seq: number; payload: unknown }[], pileKeys: Set<string>): ReplayResult {
  const decks = new Map<number, Record<string, number>>();
  let skipped = 0;
  for (const event of events) {
    const { action, before } = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as {
      action?: { type?: unknown; pileKey?: unknown; quantity?: unknown; seat?: unknown };
      before?: { currentSeat?: unknown };
    };
    if (!action) {
      skipped += 1;
      continue;
    }
    if (action.type !== 'take' && action.type !== 'return' && action.type !== 'trash') {
      continue;
    }
    const seat = action.seat ?? before?.currentSeat;
    const quantity = action.type === 'trash' ? 1 : (action.quantity ?? 1);
    if (
      typeof action.pileKey !== 'string' ||
      !pileKeys.has(action.pileKey) ||
      typeof seat !== 'number' ||
      !Number.isInteger(seat) ||
      seat < 0 ||
      seat >= MAX_SEATS ||
      typeof quantity !== 'number' ||
      !Number.isInteger(quantity) ||
      quantity < 1
    ) {
      skipped += 1;
      continue;
    }
    const cards = decks.get(seat) ?? {};
    const held = cards[action.pileKey] ?? 0;
    if (action.type === 'take') {
      cards[action.pileKey] = held + quantity;
    } else if (held > 0) {
      cards[action.pileKey] = Math.max(0, held - quantity);
    }
    decks.set(seat, cards);
  }
  return { decks, skipped };
}

/** Fills in decks for games saved before decks were tracked. Safe to run again: it only looks at games still marked 'none'. */
export async function rebuildDecks(pool: Pool, log: RebuildLogger): Promise<RebuildSummary> {
  const [candidates] = await pool.query<RowDataPacket[]>("SELECT id FROM games WHERE cards_source = 'none' ORDER BY started_at, id");
  const summary: RebuildSummary = { games: candidates.length, rebuilt: 0, skippedEvents: 0 };
  for (const candidate of candidates) {
    const id = String(candidate['id']);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [locked] = await conn.query<RowDataPacket[]>(
        "SELECT player_count FROM games WHERE id = ? AND cards_source = 'none' FOR UPDATE",
        [id],
      );
      const game = locked[0];
      if (!game) {
        await conn.rollback();
        continue;
      }
      const seats = Number(game['player_count']);
      const [piles] = await conn.query<RowDataPacket[]>('SELECT pile_key FROM game_piles WHERE game_id = ?', [id]);
      const [events] = await conn.query<RowDataPacket[]>('SELECT seq, payload FROM game_events WHERE game_id = ? ORDER BY seq', [id]);
      const parsed = events.map((event) => {
        let payload: unknown = null;
        try {
          payload = JSON.parse(String(event['payload']));
        } catch {
          payload = null;
        }
        return { seq: Number(event['seq']), payload };
      });
      const { decks, skipped } = replayDecks(parsed, new Set(piles.map((p) => String(p['pile_key']))));
      const rows: [string, number, string, number][] = [];
      for (const [seat, cards] of decks) {
        if (seat >= seats) {
          continue;
        }
        for (const [key, count] of Object.entries(cards)) {
          if (count > 0) {
            rows.push([id, seat, key, count]);
          }
        }
      }
      await conn.query('DELETE FROM game_player_cards WHERE game_id = ?', [id]);
      if (rows.length > 0) {
        await conn.query('INSERT INTO game_player_cards (game_id, seat, pile_key, count) VALUES ?', [rows]);
      }
      await conn.query("UPDATE games SET cards_source = 'rebuilt' WHERE id = ?", [id]);
      await conn.commit();
      summary.rebuilt += 1;
      summary.skippedEvents += skipped;
      if (skipped > 0) {
        log.warn({ gameId: id, skipped }, 'skipped unreadable events');
      }
    } catch (err) {
      await conn.rollback().catch(() => undefined);
      throw err;
    } finally {
      conn.release();
    }
  }
  log.info({ ...summary }, 'deck rebuild complete');
  return summary;
}
