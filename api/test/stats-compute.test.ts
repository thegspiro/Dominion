import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameState } from '../src/games/engine.js';
import { loadRules, type Rules } from '../src/games/rules.js';
import { computeStats, endingOf, historyItem, normalizeName, playerNames, type FinishedGame } from '../src/stats/compute.js';
import { logItem } from '../src/stats/log.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let rules: Rules;

beforeAll(async () => {
  rules = await loadRules(path.join(root, 'db/data'));
});

type Seat = [name: string, vp: number, turns: number];

function game(id: string, epoch: number, seats: Seat[], options: { empty?: string[]; kingdom?: string[] } = {}): FinishedGame {
  const empty = new Set(options.empty ?? []);
  const kingdom = options.kingdom ?? ['a', 'b'];
  return {
    id,
    endedAtEpoch: epoch,
    players: seats.map(([name, vp, turnsTaken], seat) => ({ seat, name, vp, turnsTaken })),
    piles: [
      { key: 'province', label: 'Province', kind: 'victory', cardId: null, count: empty.has('province') ? 0 : 3 },
      { key: 'curse', label: 'Curse', kind: 'curse', cardId: null, count: empty.has('curse') ? 0 : 5 },
      { key: 'copper', label: 'Copper', kind: 'treasure', cardId: null, count: empty.has('copper') ? 0 : 5 },
      { key: 'silver', label: 'Silver', kind: 'treasure', cardId: null, count: empty.has('silver') ? 0 : 5 },
      ...kingdom.map((card) => ({
        key: `card-${card}`,
        label: `Card ${card.toUpperCase()}`,
        kind: 'kingdom' as const,
        cardId: card,
        count: 4,
      })),
    ],
  };
}

// Newest first, as the API supplies them.
const GAMES: FinishedGame[] = [
  game('g5', 500, [['ann', 12, 10], ['BEN', 30, 10]], { empty: ['province'], kingdom: ['a', 'b'] }),
  game('g4', 400, [['Ben', 40, 10], ['Ann', 10, 10], ['Cy', 40, 10]], { empty: ['province'], kingdom: ['a', 'c'] }),
  game('g3', 300, [['Ann', 20, 10], ['Ben', 20, 10]], { kingdom: ['a', 'b'] }),
  game('g2', 200, [['Ann', 25, 9], ['Ben', 25, 10]], { empty: ['curse', 'copper', 'silver'], kingdom: ['a', 'c'] }),
  game('g1', 100, [['Ann', 30, 10], ['Ben', 20, 10]], { empty: ['province'], kingdom: ['a', 'b'] }),
  game('g0', 50, [['Ann', 5, 4], [' ann ', 6, 4]], { empty: ['province'] }),
];

describe('normalizeName', () => {
  it('ignores case and surrounding spaces', () => {
    expect(normalizeName('  AnN ')).toBe('ann');
  });
});

describe('playerNames', () => {
  it('counts each game once per name and shows the newest spelling', () => {
    expect(playerNames(GAMES)).toEqual([
      { name: 'ann', games: 6 },
      { name: 'BEN', games: 5 },
      { name: 'Cy', games: 1 },
    ]);
  });

  it('is empty without games', () => {
    expect(playerNames([])).toEqual([]);
  });
});

describe('computeStats', () => {
  const ann = () => computeStats(GAMES, 'ANN', rules);

  it('counts wins, losses and shared wins using the tracker rules', () => {
    expect(ann().record).toEqual({ games: 5, wins: 2, losses: 2, ties: 1 });
  });

  it('skips games where the name sits in two seats and reports how many', () => {
    expect(ann().ambiguousGames).toBe(1);
  });

  it('uses the newest spelling of the name', () => {
    expect(ann().name).toBe('ann');
  });

  it('averages score, opponent score and turns', () => {
    const { averages } = ann();
    expect(averages.score).toBeCloseTo(19.4);
    expect(averages.opponentScore).toBeCloseTo(27);
    expect(averages.turns).toBeCloseTo(9.8);
  });

  it('compares against each opponent by points then turns', () => {
    expect(ann().headToHead).toEqual([
      { opponent: 'BEN', games: 5, wins: 2, losses: 2, ties: 1 },
      { opponent: 'Cy', games: 1, wins: 0, losses: 1, ties: 0 },
    ]);
  });

  it('counts how games ended', () => {
    expect(ann().endings).toEqual({ province_empty: 3, colony_empty: 0, piles_empty: 1, ended_early: 1 });
  });

  it('lists cards seen in at least three games, best win rate first', () => {
    const { cards } = ann();
    expect(cards.map((c) => [c.cardId, c.games, c.wins, c.ties])).toEqual([
      ['a', 5, 2, 1],
      ['b', 3, 1, 1],
    ]);
    expect(cards[0]?.winRate).toBeCloseTo(0.4);
    expect(cards[1]?.winRate).toBeCloseTo(1 / 3);
    expect(cards[0]?.name).toBe('Card A');
  });

  it('gives a losing player in a three-player game a fair head-to-head with the shared winners', () => {
    const cy = computeStats(GAMES, 'cy', rules);
    expect(cy.record).toEqual({ games: 1, wins: 0, losses: 0, ties: 1 });
    expect(cy.headToHead).toEqual([
      { opponent: 'Ann', games: 1, wins: 1, losses: 0, ties: 0 },
      { opponent: 'Ben', games: 1, wins: 0, losses: 0, ties: 1 },
    ]);
  });

  it('returns zeros for an unknown name', () => {
    const nobody = computeStats(GAMES, 'Zed', rules);
    expect(nobody.record).toEqual({ games: 0, wins: 0, losses: 0, ties: 0 });
    expect(nobody.averages).toEqual({ score: null, opponentScore: null, turns: null });
    expect(nobody.headToHead).toEqual([]);
    expect(nobody.cards).toEqual([]);
    expect(nobody.name).toBe('Zed');
  });

  it('handles no games at all', () => {
    expect(computeStats([], 'Ann', rules).record.games).toBe(0);
  });
});

describe('endingOf', () => {
  it('reports the Province pile, the Colony pile, three piles, or an early finish', () => {
    expect(endingOf(game('x', 1, [['A', 0, 1], ['B', 0, 1]], { empty: ['province'] }), rules)).toBe('province_empty');
    expect(endingOf(game('x', 1, [['A', 0, 1], ['B', 0, 1]], { empty: ['curse', 'copper', 'silver'] }), rules)).toBe('piles_empty');
    expect(endingOf(game('x', 1, [['A', 0, 1], ['B', 0, 1]]), rules)).toBe('ended_early');
    const colony = game('x', 1, [['A', 0, 1], ['B', 0, 1]]);
    colony.piles.push({ key: 'colony', label: 'Colony', kind: 'victory', cardId: null, count: 0 });
    expect(endingOf(colony, rules)).toBe('colony_empty');
  });
});

describe('historyItem', () => {
  it('summarises a finished game', () => {
    const item = historyItem(GAMES[2] as FinishedGame, rules);
    expect(item).toEqual({
      id: 'g3',
      endedAt: new Date(300_000).toISOString(),
      turns: 10,
      ending: 'ended_early',
      players: [
        { name: 'Ann', vp: 20, turns: 10, winner: true },
        { name: 'Ben', vp: 20, turns: 10, winner: true },
      ],
      kingdom: ['Card A', 'Card B'],
    });
  });

  it('marks only the tie-break winner', () => {
    const item = historyItem(GAMES[3] as FinishedGame, rules);
    expect(item.players.map((p) => p.winner)).toEqual([true, false]);
    expect(item.turns).toBe(10);
  });
});

describe('logItem', () => {
  const before = {
    status: 'active',
    playerCount: 2,
    currentSeat: 1,
    turnNumber: 3,
    actions: 1,
    buys: 1,
    coins: 0,
    notes: [],
    players: [
      { seat: 0, name: 'Ann', vp: 3, turnsTaken: 2 },
      { seat: 1, name: 'Ben', vp: 3, turnsTaken: 2 },
    ],
    piles: [{ key: 'gold', label: 'Gold', kind: 'treasure', cardId: null, count: 30, startCount: 30, enforced: true, position: 0 }],
  } as unknown as GameState;

  it('names the player, turn and pile for a buy', () => {
    expect(logItem(4, 1000, { action: { type: 'take', pileKey: 'gold', quantity: 2 }, before })).toEqual({
      seq: 4,
      at: new Date(1_000_000).toISOString(),
      turn: 3,
      seat: 1,
      player: 'Ben',
      type: 'take',
      label: 'Gold',
      quantity: 2,
    });
  });

  it('describes points, resources, manual piles and turn changes', () => {
    expect(logItem(1, 1, { action: { type: 'vp', seat: 0, delta: 3 }, before })).toMatchObject({ type: 'vp', delta: 3, target: 'Ann', player: 'Ben' });
    expect(logItem(1, 1, { action: { type: 'resource', resource: 'coins', delta: -1 }, before })).toMatchObject({ resource: 'coins', delta: -1 });
    expect(logItem(1, 1, { action: { type: 'set_pile', pileKey: 'gold', count: 7 }, before })).toMatchObject({ label: 'Gold', count: 7 });
    expect(logItem(1, 1, { action: { type: 'end_turn' }, before })).toMatchObject({ type: 'end_turn', turn: 3, player: 'Ben' });
    expect(logItem(1, 1, { action: { type: 'finish' }, before })).toMatchObject({ type: 'finish' });
  });

  it('falls back to the pile key when the label is unknown', () => {
    expect(logItem(1, 1, { action: { type: 'take', pileKey: 'mystery', quantity: 1 }, before })?.label).toBe('mystery');
  });

  it('returns null for unreadable payloads', () => {
    expect(logItem(1, 1, null)).toBeNull();
    expect(logItem(1, 1, 'text')).toBeNull();
    expect(logItem(1, 1, { action: { type: 'dance' }, before })).toBeNull();
    expect(logItem(1, 1, { action: { type: 'end_turn' } })).toBeNull();
    expect(logItem(1, 1, { action: { type: 'end_turn' }, before: { players: 'x', piles: [] } })).toBeNull();
  });
});
