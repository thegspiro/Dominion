import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyAction,
  classifyCard,
  createGame,
  endReasons,
  gameResult,
  type Action,
  type GameState,
  type KingdomCard,
} from '../src/games/engine.js';
import { loadRules, parseRules, type Rules } from '../src/games/rules.js';

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/data');
let rules: Rules;

beforeAll(async () => {
  rules = await loadRules(dataDir);
});

const card = (name: string, extra: Partial<KingdomCard> = {}): KingdomCard => ({
  id: `00000000-0000-4000-8000-${String(name.length).padStart(4, '0')}${name.charCodeAt(0).toString(16).padStart(8, '0')}`,
  nameEn: name,
  types: ['Action'],
  costCoins: 3,
  costPotions: 0,
  ...extra,
});

const plainKingdom = (): KingdomCard[] =>
  ['Village', 'Smithy', 'Market', 'Militia', 'Moat', 'Cellar', 'Remodel', 'Laboratory', 'Witch', 'Workshop'].map((n) =>
    card(n),
  );

function newGame(names: string[], kingdom = plainKingdom(), prosperityPiles = false): GameState {
  const result = createGame(rules, { playerNames: names, kingdom, prosperityPiles });
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.state;
}

const count = (state: GameState, key: string): number | undefined => state.piles.find((p) => p.key === key)?.count;

function must(state: GameState, action: Action): GameState {
  const result = applyAction(state, action, rules);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.state;
}

describe('supply rules file', () => {
  it('loads the confirmed values', () => {
    expect(rules.copperTotal).toBe(60);
    expect(rules.victoryPile[2]).toBe(8);
    expect(rules.victoryPile[4]).toBe(12);
    expect(rules.curse[3]).toBe(20);
    expect(rules.emptyPilesEndingGame).toBe(3);
  });

  it('refuses a file nobody confirmed or with a missing player count', async () => {
    const raw = JSON.parse(
      await (await import('node:fs/promises')).readFile(path.join(dataDir, 'supply-rules.json'), 'utf8'),
    );
    expect(() => parseRules({ ...raw, confirmedBy: '' })).toThrow('confirmed');
    expect(() => parseRules({ ...raw, curse: { '2': 10, '3': 20 } })).toThrow('curse.4');
    expect(() => parseRules({ ...raw, tieBreak: 'coin-flip' })).toThrow('tieBreak');
  });
});

describe('createGame pile sizes', () => {
  it.each([
    [2, 46, 8, 10],
    [3, 39, 12, 20],
    [4, 32, 12, 30],
  ])('%i players: copper %i, victory %i, curses %i', (players, copper, victory, curses) => {
    const state = newGame(['A', 'B', 'C', 'D'].slice(0, players));
    expect(count(state, 'copper')).toBe(copper);
    expect(count(state, 'silver')).toBe(40);
    expect(count(state, 'gold')).toBe(30);
    for (const key of ['estate', 'duchy', 'province']) {
      expect(count(state, key)).toBe(victory);
    }
    expect(count(state, 'curse')).toBe(curses);
    expect(state.piles.filter((p) => p.kind === 'kingdom').every((p) => p.count === 10 && p.enforced)).toBe(true);
    expect(state.piles.filter((p) => p.kind === 'kingdom')).toHaveLength(10);
  });

  it('gives Victory-type kingdom cards the Victory pile size', () => {
    const kingdom = plainKingdom();
    kingdom[0] = card('Gardens', { types: ['Victory'], costCoins: 4 });
    expect(count(newGame(['A', 'B'], kingdom), `card:${kingdom[0].id}`)).toBe(8);
    expect(count(newGame(['A', 'B', 'C'], kingdom), `card:${kingdom[0].id}`)).toBe(12);
    const hybrid = plainKingdom();
    hybrid[0] = card('Island', { types: ['Action', 'Victory'], costCoins: 4 });
    expect(count(newGame(['A', 'B'], hybrid), `card:${hybrid[0].id}`)).toBe(8);
  });

  it('adds Potions only when a card costs a potion, and Platinum and Colony only when asked', () => {
    expect(count(newGame(['A', 'B']), 'potion')).toBeUndefined();
    const kingdom = plainKingdom();
    kingdom[0] = card('Familiar', { costPotions: 1, costCoins: 3 });
    expect(count(newGame(['A', 'B'], kingdom), 'potion')).toBe(16);
    expect(count(newGame(['A', 'B']), 'platinum')).toBeUndefined();
    const prosperity = newGame(['A', 'B'], plainKingdom(), true);
    expect(count(prosperity, 'platinum')).toBe(12);
    expect(count(prosperity, 'colony')).toBe(8);
    expect(count(newGame(['A', 'B', 'C'], plainKingdom(), true), 'colony')).toBe(12);
  });

  it('counts manual piles by hand and says so', () => {
    const kingdom = plainKingdom();
    kingdom[0] = card('Encampment');
    kingdom[1] = card('Humble Castle', { types: ['Victory', 'Castle'], costCoins: 3 });
    const state = newGame(['A', 'B'], kingdom);
    const manual = state.piles.filter((p) => !p.enforced);
    expect(manual.map((p) => p.label).sort()).toEqual(['Encampment', 'Humble Castle']);
    expect(state.notes.filter((n) => n.includes('counted by hand'))).toHaveLength(2);
  });

  it('warns about cards that need an extra pile', () => {
    const kingdom = plainKingdom();
    kingdom[0] = card('Cultist', { types: ['Action', 'Attack', 'Looter'], costCoins: 5 });
    expect(newGame(['A', 'B'], kingdom).notes.join(' ')).toContain('Cultist needs an extra pile');
  });

  it('rejects bad input', () => {
    const base = { playerNames: ['A', 'B'], kingdom: plainKingdom(), prosperityPiles: false };
    const reason = (input: Parameters<typeof createGame>[1]) => {
      const r = createGame(rules, input);
      return r.ok ? 'ok' : r.reason;
    };
    expect(reason({ ...base, playerNames: ['A'] })).toBe('invalid_player_count');
    expect(reason({ ...base, playerNames: ['A', 'B', 'C', 'D', 'E'] })).toBe('invalid_player_count');
    expect(reason({ ...base, playerNames: ['A', ' '] })).toBe('invalid_player_name');
    expect(reason({ ...base, playerNames: ['A', 'a'] })).toBe('duplicate_player_name');
    expect(reason({ ...base, kingdom: plainKingdom().slice(0, 9) })).toBe('kingdom_size');
    const dup = plainKingdom();
    dup[1] = dup[0] as KingdomCard;
    expect(reason({ ...base, kingdom: dup })).toBe('duplicate_kingdom_card');
    const event = plainKingdom();
    event[0] = card('Delve', { types: ['Event'], costCoins: 2 });
    expect(reason({ ...base, kingdom: event })).toBe('not_a_supply_card');
  });
});

describe('classifyCard', () => {
  it('separates supply, manual and non-supply cards', () => {
    expect(classifyCard(card('Village'), rules)).toBe('supply');
    expect(classifyCard(card('Rocks'), rules)).toBe('manual');
    expect(classifyCard(card('Sir Martin', { types: ['Action', 'Attack', 'Knight'] }), rules)).toBe('manual');
    expect(classifyCard(card('Delve', { types: ['Event'] }), rules)).toBe('not_supply');
    expect(classifyCard(card('Spoils', { types: ['Treasure'], costCoins: 0 }), rules)).toBe('not_supply');
    expect(classifyCard(card('Bat', { costCoins: null }), rules)).toBe('not_supply');
  });
});

describe('applyAction', () => {
  it('takes and returns cards within the pile limits', () => {
    let state = newGame(['A', 'B']);
    state = must(state, { type: 'take', pileKey: 'province', quantity: 2 });
    expect(count(state, 'province')).toBe(6);
    state = must(state, { type: 'return', pileKey: 'province', quantity: 1 });
    expect(count(state, 'province')).toBe(7);
    const full = applyAction(state, { type: 'return', pileKey: 'province', quantity: 2 }, rules);
    expect(full).toEqual({ ok: false, reason: 'pile_full' });
    const over = applyAction(state, { type: 'take', pileKey: 'province', quantity: 8 }, rules);
    expect(over).toEqual({ ok: false, reason: 'pile_empty' });
    expect(applyAction(state, { type: 'take', pileKey: 'nope', quantity: 1 }, rules)).toEqual({
      ok: false,
      reason: 'unknown_pile',
    });
  });

  it('does not change the state it was given', () => {
    const state = newGame(['A', 'B']);
    const before = structuredClone(state);
    must(state, { type: 'take', pileKey: 'copper', quantity: 5 });
    expect(state).toEqual(before);
  });

  it('only lets manual piles be set directly', () => {
    const kingdom = plainKingdom();
    kingdom[0] = card('Encampment');
    const state = newGame(['A', 'B'], kingdom);
    const manualKey = `card:${kingdom[0].id}`;
    expect(count(must(state, { type: 'set_pile', pileKey: manualKey, count: 7 }), manualKey)).toBe(7);
    expect(applyAction(state, { type: 'set_pile', pileKey: 'gold', count: 3 }, rules)).toEqual({
      ok: false,
      reason: 'pile_enforced',
    });
    expect(applyAction(state, { type: 'set_pile', pileKey: manualKey, count: 1000 }, rules)).toEqual({
      ok: false,
      reason: 'out_of_range',
    });
  });

  it('keeps resources between 0 and 99', () => {
    let state = newGame(['A', 'B']);
    state = must(state, { type: 'resource', resource: 'coins', delta: 5 });
    expect(state.coins).toBe(5);
    expect(applyAction(state, { type: 'resource', resource: 'coins', delta: -6 }, rules)).toEqual({
      ok: false,
      reason: 'out_of_range',
    });
    expect(applyAction(state, { type: 'resource', resource: 'buys', delta: 99 }, rules)).toEqual({
      ok: false,
      reason: 'out_of_range',
    });
  });

  it('adjusts victory points, including negatives, for a real seat only', () => {
    let state = newGame(['A', 'B']);
    state = must(state, { type: 'vp', seat: 1, delta: -1 });
    expect(state.players[1]?.vp).toBe(-1);
    expect(applyAction(state, { type: 'vp', seat: 2, delta: 1 }, rules)).toEqual({ ok: false, reason: 'unknown_player' });
    expect(applyAction(state, { type: 'vp', seat: 0, delta: 10000 }, rules)).toEqual({ ok: false, reason: 'out_of_range' });
  });

  it('passes the turn around the table and resets resources', () => {
    let state = newGame(['A', 'B', 'C']);
    state = must(state, { type: 'resource', resource: 'coins', delta: 6 });
    state = must(state, { type: 'resource', resource: 'actions', delta: 2 });
    state = must(state, { type: 'end_turn' });
    expect([state.currentSeat, state.turnNumber, state.actions, state.buys, state.coins]).toEqual([1, 1, 1, 1, 0]);
    state = must(must(state, { type: 'end_turn' }), { type: 'end_turn' });
    expect([state.currentSeat, state.turnNumber]).toEqual([0, 2]);
    expect(state.players.map((p) => p.turnsTaken)).toEqual([1, 1, 1]);
  });

  it('refuses everything once the game is over', () => {
    const state = must(newGame(['A', 'B']), { type: 'finish' });
    expect(state.status).toBe('finished');
    expect(applyAction(state, { type: 'end_turn' }, rules)).toEqual({ ok: false, reason: 'game_not_active' });
    expect(applyAction(must(newGame(['A', 'B']), { type: 'abandon' }), { type: 'finish' }, rules).ok).toBe(false);
  });
});

describe('end of game', () => {
  it('ends at the end of the turn in which the Province pile empties', () => {
    let state = newGame(['A', 'B']);
    state = must(state, { type: 'take', pileKey: 'province', quantity: 8 });
    expect(endReasons(state, rules)).toEqual(['province_empty']);
    expect(state.status).toBe('active');
    state = must(state, { type: 'end_turn' });
    expect(state.status).toBe('finished');
    expect(state.currentSeat).toBe(0);
  });

  it('ends when any three piles are empty, not before', () => {
    let state = newGame(['A', 'B']);
    for (const key of ['curse', 'estate']) {
      state = must(state, { type: 'take', pileKey: key, quantity: count(state, key) as number });
    }
    expect(endReasons(state, rules)).toEqual([]);
    state = must(state, { type: 'take', pileKey: 'duchy', quantity: 8 });
    expect(endReasons(state, rules)).toEqual(['piles_empty']);
    expect(must(state, { type: 'end_turn' }).status).toBe('finished');
  });

  it('counts the Colony pile only when Colonies are in play', () => {
    let state = newGame(['A', 'B'], plainKingdom(), true);
    state = must(state, { type: 'take', pileKey: 'colony', quantity: 8 });
    expect(endReasons(state, rules)).toEqual(['colony_empty']);
    const noColony = newGame(['A', 'B']);
    expect(endReasons(noColony, rules)).toEqual([]);
  });
});

describe('gameResult', () => {
  const withScores = (scores: [number, number][]): GameState => {
    const state = newGame(scores.map((_, i) => `P${i + 1}`));
    state.players.forEach((p, i) => {
      p.vp = (scores[i] as [number, number])[0];
      p.turnsTaken = (scores[i] as [number, number])[1];
    });
    return state;
  };

  it('gives the win to the highest score', () => {
    expect(gameResult(withScores([[30, 15], [35, 15]]))).toEqual({ winners: [1], tiedOnPoints: false });
  });

  it('breaks a tie in favour of the player with fewer turns', () => {
    expect(gameResult(withScores([[30, 15], [30, 14]]))).toEqual({ winners: [1], tiedOnPoints: true });
  });

  it('shares the win on equal points and equal turns, ignoring lower scores', () => {
    expect(gameResult(withScores([[30, 15], [30, 15], [12, 15]]))).toEqual({ winners: [0, 1], tiedOnPoints: true });
  });

  it('handles negative scores', () => {
    expect(gameResult(withScores([[-3, 10], [-5, 10]])).winners).toEqual([0]);
  });
});
