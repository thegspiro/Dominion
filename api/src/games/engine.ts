import type { Rules } from './rules.js';

export type PileKind = 'treasure' | 'victory' | 'curse' | 'kingdom';
export type GameStatus = 'active' | 'finished' | 'abandoned';

export interface PileState {
  key: string;
  label: string;
  kind: PileKind;
  cardId: string | null;
  count: number;
  startCount: number;
  enforced: boolean;
  position: number;
}

export interface PlayerState {
  seat: number;
  name: string;
  vp: number;
  turnsTaken: number;
}

export interface GameState {
  status: GameStatus;
  playerCount: number;
  currentSeat: number;
  turnNumber: number;
  actions: number;
  buys: number;
  coins: number;
  notes: string[];
  players: PlayerState[];
  piles: PileState[];
}

export interface KingdomCard {
  id: string;
  nameEn: string;
  types: string[];
  costCoins: number | null;
  costPotions: number;
}

export type Resource = 'actions' | 'buys' | 'coins';

export type Action =
  | { type: 'take'; pileKey: string; quantity: number }
  | { type: 'return'; pileKey: string; quantity: number }
  | { type: 'set_pile'; pileKey: string; count: number }
  | { type: 'resource'; resource: Resource; delta: number }
  | { type: 'vp'; seat: number; delta: number }
  | { type: 'end_turn' }
  | { type: 'finish' }
  | { type: 'abandon' };

export type Failure = { ok: false; reason: string };
export type Success = { ok: true; state: GameState };

export const MAX_RESOURCE = 99;
export const MAX_MANUAL_PILE = 999;
export const MIN_VP = -999;
export const MAX_VP = 9999;
export const MAX_NAME_LENGTH = 32;

export type CardClass = 'supply' | 'manual' | 'not_supply';

/** Decides how the tracker treats a card chosen for the kingdom. */
export function classifyCard(card: KingdomCard, rules: Rules): CardClass {
  if (card.costCoins === null || rules.notSupplyCards.has(card.nameEn)) {
    return 'not_supply';
  }
  if (card.types.some((type) => rules.notSupplyTypes.has(type))) {
    return 'not_supply';
  }
  if (rules.manualPileCards.has(card.nameEn) || card.types.some((type) => rules.manualPileTypes.has(type))) {
    return 'manual';
  }
  return 'supply';
}

export interface NewGame {
  playerNames: string[];
  kingdom: KingdomCard[];
  prosperityPiles: boolean;
}

export type CreateResult = { ok: true; state: GameState } | Failure;

export function createGame(rules: Rules, input: NewGame): CreateResult {
  const players = input.playerNames.length;
  if (players < rules.minPlayers || players > rules.maxPlayers) {
    return { ok: false, reason: 'invalid_player_count' };
  }
  const names = input.playerNames.map((name) => name.trim());
  if (names.some((name) => name === '' || name.length > MAX_NAME_LENGTH)) {
    return { ok: false, reason: 'invalid_player_name' };
  }
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
    return { ok: false, reason: 'duplicate_player_name' };
  }
  if (input.kingdom.length !== rules.kingdomPile) {
    return { ok: false, reason: 'kingdom_size' };
  }
  if (
    new Set(input.kingdom.map((c) => c.id)).size !== input.kingdom.length ||
    new Set(input.kingdom.map((c) => c.nameEn)).size !== input.kingdom.length
  ) {
    return { ok: false, reason: 'duplicate_kingdom_card' };
  }
  const classes = input.kingdom.map((card) => classifyCard(card, rules));
  if (classes.includes('not_supply')) {
    return { ok: false, reason: 'not_a_supply_card' };
  }

  const piles: PileState[] = [];
  const add = (
    key: string,
    label: string,
    kind: PileKind,
    count: number,
    cardId: string | null = null,
    enforced = true,
  ): void => {
    piles.push({ key, label, kind, cardId, count, startCount: count, enforced, position: piles.length });
  };

  const needsPotions = input.kingdom.some((card) => card.costPotions > 0);
  const victoryCount = rules.victoryPile[players] as number;

  add('copper', 'Copper', 'treasure', rules.copperTotal - rules.copperStartingPerPlayer * players);
  add('silver', 'Silver', 'treasure', rules.silver);
  add('gold', 'Gold', 'treasure', rules.gold);
  if (needsPotions) {
    add('potion', 'Potion', 'treasure', rules.potion);
  }
  if (input.prosperityPiles) {
    add('platinum', 'Platinum', 'treasure', rules.platinum);
  }
  add('estate', 'Estate', 'victory', victoryCount);
  add('duchy', 'Duchy', 'victory', victoryCount);
  add('province', 'Province', 'victory', victoryCount);
  if (input.prosperityPiles) {
    add('colony', 'Colony', 'victory', rules.colony[players] as number);
  }
  add('curse', 'Curse', 'curse', rules.curse[players] as number);

  const notes: string[] = [];
  const ordered = input.kingdom
    .map((card, index) => ({ card, cls: classes[index] as CardClass }))
    .sort((a, b) => (a.card.costCoins ?? 0) - (b.card.costCoins ?? 0) || a.card.nameEn.localeCompare(b.card.nameEn));
  for (const { card, cls } of ordered) {
    const isVictory = card.types.includes('Victory');
    const count = isVictory ? victoryCount : rules.kingdomPile;
    if (cls === 'manual') {
      add(`card:${card.id}`, card.nameEn, 'kingdom', count, card.id, false);
      notes.push(`${card.nameEn}: this pile is counted by hand (its rules are not enforced). Set the real number of cards.`);
    } else {
      add(`card:${card.id}`, card.nameEn, 'kingdom', count, card.id, true);
    }
    if (card.types.some((type) => rules.needsExtraPileTypes.has(type))) {
      notes.push(`${card.nameEn} needs an extra pile (such as Ruins) that this tracker does not add. Track it yourself.`);
    }
  }

  return {
    ok: true,
    state: {
      status: 'active',
      playerCount: players,
      currentSeat: 0,
      turnNumber: 1,
      actions: 1,
      buys: 1,
      coins: 0,
      notes,
      players: names.map((name, seat) => ({ seat, name, vp: 0, turnsTaken: 0 })),
      piles,
    },
  };
}

export type EndReason = 'province_empty' | 'colony_empty' | 'piles_empty';

export function endReasons(state: GameState, rules: Rules): EndReason[] {
  const reasons: EndReason[] = [];
  const emptyKey = (key: string): boolean => state.piles.some((pile) => pile.key === key && pile.count === 0);
  if (rules.endingPiles.includes('province') && emptyKey('province')) {
    reasons.push('province_empty');
  }
  if (rules.endingPiles.includes('colony') && emptyKey('colony')) {
    reasons.push('colony_empty');
  }
  if (state.piles.filter((pile) => pile.count === 0).length >= rules.emptyPilesEndingGame) {
    reasons.push('piles_empty');
  }
  return reasons;
}

export interface GameResult {
  winners: number[];
  tiedOnPoints: boolean;
}

/** Highest VP wins; among tied players the fewest turns wins; otherwise the win is shared. */
export function gameResult(state: GameState): GameResult {
  const best = Math.max(...state.players.map((p) => p.vp));
  const top = state.players.filter((p) => p.vp === best);
  const fewest = Math.min(...top.map((p) => p.turnsTaken));
  return {
    winners: top.filter((p) => p.turnsTaken === fewest).map((p) => p.seat),
    tiedOnPoints: top.length > 1,
  };
}

const fail = (reason: string): Failure => ({ ok: false, reason });

export function applyAction(state: GameState, action: Action, rules: Rules): Success | Failure {
  if (state.status !== 'active') {
    return fail('game_not_active');
  }
  const next = structuredClone(state);
  const findPile = (key: string): PileState | undefined => next.piles.find((pile) => pile.key === key);

  switch (action.type) {
    case 'take': {
      const pile = findPile(action.pileKey);
      if (!pile) {
        return fail('unknown_pile');
      }
      if (pile.count < action.quantity) {
        return fail('pile_empty');
      }
      pile.count -= action.quantity;
      return { ok: true, state: next };
    }
    case 'return': {
      const pile = findPile(action.pileKey);
      if (!pile) {
        return fail('unknown_pile');
      }
      const limit = pile.enforced ? pile.startCount : MAX_MANUAL_PILE;
      if (pile.count + action.quantity > limit) {
        return fail('pile_full');
      }
      pile.count += action.quantity;
      return { ok: true, state: next };
    }
    case 'set_pile': {
      const pile = findPile(action.pileKey);
      if (!pile) {
        return fail('unknown_pile');
      }
      if (pile.enforced) {
        return fail('pile_enforced');
      }
      if (action.count < 0 || action.count > MAX_MANUAL_PILE) {
        return fail('out_of_range');
      }
      pile.count = action.count;
      return { ok: true, state: next };
    }
    case 'resource': {
      const value = next[action.resource] + action.delta;
      if (value < 0 || value > MAX_RESOURCE) {
        return fail('out_of_range');
      }
      next[action.resource] = value;
      return { ok: true, state: next };
    }
    case 'vp': {
      const player = next.players.find((p) => p.seat === action.seat);
      if (!player) {
        return fail('unknown_player');
      }
      const value = player.vp + action.delta;
      if (value < MIN_VP || value > MAX_VP) {
        return fail('out_of_range');
      }
      player.vp = value;
      return { ok: true, state: next };
    }
    case 'end_turn': {
      const current = next.players.find((p) => p.seat === next.currentSeat);
      if (!current) {
        return fail('unknown_player');
      }
      current.turnsTaken += 1;
      if (endReasons(next, rules).length > 0) {
        next.status = 'finished';
        return { ok: true, state: next };
      }
      next.currentSeat = (next.currentSeat + 1) % next.playerCount;
      if (next.currentSeat === 0) {
        next.turnNumber += 1;
      }
      next.actions = 1;
      next.buys = 1;
      next.coins = 0;
      return { ok: true, state: next };
    }
    case 'finish':
      next.status = 'finished';
      return { ok: true, state: next };
    case 'abandon':
      next.status = 'abandoned';
      return { ok: true, state: next };
  }
}
