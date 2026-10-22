import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { GameState, GameStatus, PileKind, PileState, PlayerState } from './engine.js';

export interface GameMeta {
  id: string;
  version: number;
  startedAt: Date;
  endedAt: Date | null;
  eventCount: number;
  cardsSource: CardsSource;
}

export interface LoadedGame {
  meta: GameMeta;
  state: GameState;
}

export interface GameSummary {
  id: string;
  status: GameStatus;
  playerCount: number;
  turnNumber: number;
  startedAt: Date;
  endedAt: Date | null;
  players: string[];
}

export type CardsSource = 'tracked' | 'rebuilt' | 'none';

type Queryable = Pool | PoolConnection;

function parseNotes(text: string): string[] {
  const parsed: unknown = JSON.parse(text);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

export async function insertGame(conn: PoolConnection, id: string, ownerId: number, state: GameState): Promise<void> {
  await conn.query(
    `INSERT INTO games (id, owner_user_id, status, player_count, current_seat, turn_number, actions, buys, coins, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      ownerId,
      state.status,
      state.playerCount,
      state.currentSeat,
      state.turnNumber,
      state.actions,
      state.buys,
      state.coins,
      JSON.stringify(state.notes),
    ],
  );
  await conn.query('INSERT INTO game_players (game_id, seat, name, vp, turns_taken) VALUES ?', [
    state.players.map((p) => [id, p.seat, p.name, p.vp, p.turnsTaken]),
  ]);
  await conn.query(
    'INSERT INTO game_piles (game_id, pile_key, label, kind, card_id, count, start_count, enforced, position) VALUES ?',
    [state.piles.map((p) => [id, p.key, p.label, p.kind, p.cardId, p.count, p.startCount, p.enforced ? 1 : 0, p.position])],
  );
}

/** Loads a game owned by the given user, or null. With lock, the games row is held until the transaction ends. */
export async function loadGame(db: Queryable, id: string, ownerId: number, lock: boolean): Promise<LoadedGame | null> {
  const [games] = await db.query<RowDataPacket[]>(
    `SELECT id, status, player_count, current_seat, turn_number, actions, buys, coins, version, notes, started_at, ended_at, cards_source
       FROM games WHERE id = ? AND owner_user_id = ? ${lock ? 'FOR UPDATE' : ''}`,
    [id, ownerId],
  );
  const game = games[0];
  if (!game) {
    return null;
  }
  const [players] = await db.query<RowDataPacket[]>(
    'SELECT seat, name, vp, turns_taken FROM game_players WHERE game_id = ? ORDER BY seat',
    [id],
  );
  const [piles] = await db.query<RowDataPacket[]>(
    'SELECT pile_key, label, kind, card_id, count, start_count, enforced, position FROM game_piles WHERE game_id = ? ORDER BY position',
    [id],
  );
  const [events] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM game_events WHERE game_id = ?', [id]);
  const [held] = await db.query<RowDataPacket[]>('SELECT seat, pile_key, count FROM game_player_cards WHERE game_id = ?', [id]);
  const cardsBySeat = new Map<number, Record<string, number>>();
  for (const row of held) {
    const cards = cardsBySeat.get(Number(row['seat'])) ?? {};
    cards[String(row['pile_key'])] = Number(row['count']);
    cardsBySeat.set(Number(row['seat']), cards);
  }
  return {
    meta: {
      id,
      version: Number(game['version']),
      startedAt: game['started_at'] as Date,
      endedAt: (game['ended_at'] as Date | null) ?? null,
      eventCount: Number(events[0]?.['n'] ?? 0),
      cardsSource: game['cards_source'] as CardsSource,
    },
    state: {
      status: game['status'] as GameStatus,
      playerCount: Number(game['player_count']),
      currentSeat: Number(game['current_seat']),
      turnNumber: Number(game['turn_number']),
      actions: Number(game['actions']),
      buys: Number(game['buys']),
      coins: Number(game['coins']),
      notes: parseNotes(String(game['notes'])),
      players: players.map(
        (p): PlayerState => ({
          seat: Number(p['seat']),
          name: String(p['name']),
          vp: Number(p['vp']),
          turnsTaken: Number(p['turns_taken']),
          cards: cardsBySeat.get(Number(p['seat'])) ?? {},
        }),
      ),
      piles: piles.map(
        (p): PileState => ({
          key: String(p['pile_key']),
          label: String(p['label']),
          kind: p['kind'] as PileKind,
          cardId: p['card_id'] === null ? null : String(p['card_id']),
          count: Number(p['count']),
          startCount: Number(p['start_count']),
          enforced: Number(p['enforced']) === 1,
          position: Number(p['position']),
        }),
      ),
    },
  };
}

/** Writes the differences between two states of the same game and bumps its version. */
export async function saveChanges(conn: PoolConnection, id: string, before: GameState, after: GameState): Promise<void> {
  await conn.query(
    `UPDATE games SET status = ?, current_seat = ?, turn_number = ?, actions = ?, buys = ?, coins = ?, version = version + 1,
            ended_at = CASE WHEN ? = 'active' THEN NULL WHEN ended_at IS NULL THEN NOW() ELSE ended_at END
      WHERE id = ?`,
    [after.status, after.currentSeat, after.turnNumber, after.actions, after.buys, after.coins, after.status, id],
  );
  for (const player of after.players) {
    const old = before.players.find((p) => p.seat === player.seat);
    if (!old || old.vp !== player.vp || old.turnsTaken !== player.turnsTaken) {
      await conn.query('UPDATE game_players SET vp = ?, turns_taken = ? WHERE game_id = ? AND seat = ?', [
        player.vp,
        player.turnsTaken,
        id,
        player.seat,
      ]);
    }
  }
  for (const player of after.players) {
    if (player.cards === undefined) {
      continue;
    }
    const old = before.players.find((p) => p.seat === player.seat)?.cards ?? {};
    for (const key of new Set([...Object.keys(old), ...Object.keys(player.cards)])) {
      const was = old[key] ?? 0;
      const now = player.cards[key] ?? 0;
      if (was === now) {
        continue;
      }
      if (now === 0) {
        await conn.query('DELETE FROM game_player_cards WHERE game_id = ? AND seat = ? AND pile_key = ?', [id, player.seat, key]);
      } else {
        await conn.query(
          'INSERT INTO game_player_cards (game_id, seat, pile_key, count) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE count = VALUES(count)',
          [id, player.seat, key, now],
        );
      }
    }
  }
  for (const pile of after.piles) {
    const old = before.piles.find((p) => p.key === pile.key);
    if (!old || old.count !== pile.count) {
      await conn.query('UPDATE game_piles SET count = ? WHERE game_id = ? AND pile_key = ?', [pile.count, id, pile.key]);
    }
  }
}

export async function appendEvent(conn: PoolConnection, id: string, type: string, payload: unknown): Promise<void> {
  await conn.query(
    `INSERT INTO game_events (game_id, seq, type, payload)
     SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ? FROM game_events WHERE game_id = ?`,
    [id, type, JSON.stringify(payload), id],
  );
}

/** Removes and returns the snapshot taken before the most recent event, or null when there is none. */
export async function popLastEvent(conn: PoolConnection, id: string): Promise<GameState | null> {
  const [rows] = await conn.query<RowDataPacket[]>(
    'SELECT seq, payload FROM game_events WHERE game_id = ? ORDER BY seq DESC LIMIT 1 FOR UPDATE',
    [id],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  const payload = JSON.parse(String(row['payload'])) as { before: GameState };
  const [deleted] = await conn.query<ResultSetHeader>('DELETE FROM game_events WHERE game_id = ? AND seq = ?', [
    id,
    row['seq'],
  ]);
  if (deleted.affectedRows !== 1) {
    throw new Error('Could not remove the event being undone');
  }
  return payload.before;
}

export async function listGames(pool: Pool, ownerId: number): Promise<GameSummary[]> {
  const [games] = await pool.query<RowDataPacket[]>(
    `SELECT id, status, player_count, turn_number, started_at, ended_at FROM games
      WHERE owner_user_id = ? ORDER BY started_at DESC, id LIMIT 100`,
    [ownerId],
  );
  if (games.length === 0) {
    return [];
  }
  const [players] = await pool.query<RowDataPacket[]>(
    'SELECT game_id, name FROM game_players WHERE game_id IN (?) ORDER BY game_id, seat',
    [games.map((g) => g['id'])],
  );
  const names = new Map<string, string[]>();
  for (const p of players) {
    const list = names.get(String(p['game_id'])) ?? [];
    list.push(String(p['name']));
    names.set(String(p['game_id']), list);
  }
  return games.map((g) => ({
    id: String(g['id']),
    status: g['status'] as GameStatus,
    playerCount: Number(g['player_count']),
    turnNumber: Number(g['turn_number']),
    startedAt: g['started_at'] as Date,
    endedAt: (g['ended_at'] as Date | null) ?? null,
    players: names.get(String(g['id'])) ?? [],
  }));
}
