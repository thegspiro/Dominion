import { endReasons, gameResult, type EndReason, type PileState, type PlayerState } from '../games/engine.js';
import type { Rules } from '../games/rules.js';

export type Ending = EndReason | 'ended_early';

export interface FinishedGame {
  id: string;
  endedAtEpoch: number;
  players: PlayerState[];
  piles: Pick<PileState, 'key' | 'label' | 'kind' | 'cardId' | 'count'>[];
}

export interface HistoryItem {
  id: string;
  endedAt: string;
  turns: number;
  ending: Ending;
  players: { name: string; vp: number; turns: number; winner: boolean }[];
  kingdom: string[];
}

export interface Tally {
  games: number;
  wins: number;
  losses: number;
  ties: number;
}

export interface CardStat {
  cardId: string;
  name: string;
  games: number;
  wins: number;
  ties: number;
  winRate: number;
}

export interface PlayerStats {
  name: string;
  record: Tally;
  ambiguousGames: number;
  averages: { score: number | null; opponentScore: number | null; turns: number | null };
  headToHead: (Tally & { opponent: string })[];
  endings: Record<Ending, number>;
  cards: CardStat[];
}

export const MIN_CARD_GAMES = 3;
const MAX_CARDS = 30;

export const normalizeName = (name: string): string => name.trim().toLowerCase();

const emptyTally = (): Tally => ({ games: 0, wins: 0, losses: 0, ties: 0 });
const emptyEndings = (): Record<Ending, number> => ({ province_empty: 0, colony_empty: 0, piles_empty: 0, ended_early: 0 });

/** The reason that ended the game; a game finished by hand with no ending condition met is "ended_early". */
export function endingOf(game: FinishedGame, rules: Rules): Ending {
  return endReasons(game, rules)[0] ?? 'ended_early';
}

export function historyItem(game: FinishedGame, rules: Rules): HistoryItem {
  const winners = new Set(gameResult(game).winners);
  return {
    id: game.id,
    endedAt: new Date(game.endedAtEpoch * 1000).toISOString(),
    turns: Math.max(...game.players.map((p) => p.turnsTaken)),
    ending: endingOf(game, rules),
    players: game.players.map((p) => ({ name: p.name, vp: p.vp, turns: p.turnsTaken, winner: winners.has(p.seat) })),
    kingdom: game.piles.filter((p) => p.kind === 'kingdom').map((p) => p.label),
  };
}

/** Names seen in finished games with how many games each appears in. `games` must be newest first so the latest spelling is shown. */
export function playerNames(games: FinishedGame[]): { name: string; games: number }[] {
  const seen = new Map<string, { name: string; games: number }>();
  for (const game of games) {
    for (const key of new Set(game.players.map((p) => normalizeName(p.name)))) {
      const existing = seen.get(key);
      if (existing) {
        existing.games += 1;
      } else {
        const display = game.players.find((p) => normalizeName(p.name) === key)?.name.trim() ?? key;
        seen.set(key, { name: display, games: 1 });
      }
    }
  }
  return [...seen.values()].sort((a, b) => b.games - a.games || a.name.localeCompare(b.name));
}

const mean = (values: number[]): number | null => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);

/** Pairwise result: more points wins, then fewer turns; equal on both is a tie. */
function pairwise(me: PlayerState, other: PlayerState): 'win' | 'loss' | 'tie' {
  if (me.vp !== other.vp) {
    return me.vp > other.vp ? 'win' : 'loss';
  }
  if (me.turnsTaken !== other.turnsTaken) {
    return me.turnsTaken < other.turnsTaken ? 'win' : 'loss';
  }
  return 'tie';
}

/** Statistics for one player over finished games. `games` must be newest first. */
export function computeStats(games: FinishedGame[], player: string, rules: Rules): PlayerStats {
  const wanted = normalizeName(player);
  const record = emptyTally();
  const endings = emptyEndings();
  const scores: number[] = [];
  const opponentScores: number[] = [];
  const turns: number[] = [];
  const opponents = new Map<string, Tally & { opponent: string }>();
  const cards = new Map<string, CardStat>();
  let ambiguousGames = 0;
  let display = player.trim();
  let displayed = false;

  for (const game of games) {
    const mine = game.players.filter((p) => normalizeName(p.name) === wanted);
    if (mine.length === 0) {
      continue;
    }
    const me = mine[0];
    if (mine.length > 1 || !me) {
      ambiguousGames += 1;
      continue;
    }
    if (!displayed) {
      display = me.name.trim();
      displayed = true;
    }

    const winners = gameResult(game).winners;
    const outcome = !winners.includes(me.seat) ? 'loss' : winners.length === 1 ? 'win' : 'tie';
    record.games += 1;
    record[outcome === 'win' ? 'wins' : outcome === 'loss' ? 'losses' : 'ties'] += 1;
    endings[endingOf(game, rules)] += 1;
    scores.push(me.vp);
    turns.push(me.turnsTaken);

    const others = game.players.filter((p) => p.seat !== me.seat);
    const otherMean = mean(others.map((p) => p.vp));
    if (otherMean !== null) {
      opponentScores.push(otherMean);
    }
    for (const other of others) {
      const key = normalizeName(other.name);
      const row = opponents.get(key) ?? { opponent: other.name.trim(), ...emptyTally() };
      const result = pairwise(me, other);
      row.games += 1;
      row[result === 'win' ? 'wins' : result === 'loss' ? 'losses' : 'ties'] += 1;
      opponents.set(key, row);
    }

    for (const pile of game.piles) {
      if (pile.kind !== 'kingdom' || pile.cardId === null) {
        continue;
      }
      const card = cards.get(pile.cardId) ?? { cardId: pile.cardId, name: pile.label, games: 0, wins: 0, ties: 0, winRate: 0 };
      card.games += 1;
      if (outcome === 'win') {
        card.wins += 1;
      } else if (outcome === 'tie') {
        card.ties += 1;
      }
      cards.set(pile.cardId, card);
    }
  }

  return {
    name: display,
    record,
    ambiguousGames,
    averages: { score: mean(scores), opponentScore: mean(opponentScores), turns: mean(turns) },
    headToHead: [...opponents.values()].sort((a, b) => b.games - a.games || a.opponent.localeCompare(b.opponent)),
    endings,
    cards: [...cards.values()]
      .filter((c) => c.games >= MIN_CARD_GAMES)
      .map((c) => ({ ...c, winRate: c.wins / c.games }))
      .sort((a, b) => b.winRate - a.winRate || b.games - a.games || a.name.localeCompare(b.name))
      .slice(0, MAX_CARDS),
  };
}
