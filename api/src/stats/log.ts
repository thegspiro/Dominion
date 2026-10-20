import type { Action, GameState } from '../games/engine.js';

export interface LogItem {
  seq: number;
  at: string;
  turn: number;
  seat: number;
  player: string;
  type: Action['type'];
  label?: string;
  quantity?: number;
  count?: number;
  resource?: 'actions' | 'buys' | 'coins';
  delta?: number;
  target?: string;
}

const TYPES = new Set(['take', 'return', 'set_pile', 'resource', 'vp', 'end_turn', 'finish', 'abandon']);

/**
 * Turns a stored event into a log line. The payload is `{action, before}` where `before` is the game as it stood
 * when the action was taken, so names, labels and the turn come from it. Returns null for anything unreadable.
 */
export function logItem(seq: number, atEpoch: number, payload: unknown): LogItem | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const { action, before } = payload as { action?: Action; before?: GameState };
  if (!action || !before || !TYPES.has(action.type) || !Array.isArray(before.players) || !Array.isArray(before.piles)) {
    return null;
  }
  const seat = before.currentSeat;
  const item: LogItem = {
    seq,
    at: new Date(atEpoch * 1000).toISOString(),
    turn: before.turnNumber,
    seat,
    player: before.players.find((p) => p.seat === seat)?.name ?? `Player ${seat + 1}`,
    type: action.type,
  };
  const label = (key: string): string => before.piles.find((p) => p.key === key)?.label ?? key;
  switch (action.type) {
    case 'take':
    case 'return':
      item.label = label(action.pileKey);
      item.quantity = action.quantity;
      break;
    case 'set_pile':
      item.label = label(action.pileKey);
      item.count = action.count;
      break;
    case 'resource':
      item.resource = action.resource;
      item.delta = action.delta;
      break;
    case 'vp':
      item.delta = action.delta;
      item.target = before.players.find((p) => p.seat === action.seat)?.name ?? `Player ${action.seat + 1}`;
      break;
    default:
      break;
  }
  return item;
}
