import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface Rules {
  minPlayers: number;
  maxPlayers: number;
  copperTotal: number;
  copperStartingPerPlayer: number;
  silver: number;
  gold: number;
  potion: number;
  platinum: number;
  victoryPile: Record<number, number>;
  colony: Record<number, number>;
  curse: Record<number, number>;
  kingdomPile: number;
  emptyPilesEndingGame: number;
  endingPiles: string[];
  notSupplyTypes: Set<string>;
  notSupplyCards: Set<string>;
  manualPileTypes: Set<string>;
  manualPileCards: Set<string>;
  needsExtraPileTypes: Set<string>;
}

type Json = Record<string, unknown>;

function obj(value: unknown, where: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  return value as Json;
}

function int(value: unknown, where: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${where} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function strings(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v === '')) {
    throw new Error(`${where} must be an array of non-empty strings`);
  }
  return value as string[];
}

function byPlayers(value: unknown, where: string, min: number, max: number): Record<number, number> {
  const source = obj(value, where);
  const result: Record<number, number> = {};
  for (let players = min; players <= max; players += 1) {
    result[players] = int(source[String(players)], `${where}.${players}`, 0, 999);
  }
  return result;
}

export function parseRules(raw: unknown): Rules {
  const data = obj(raw, 'supply rules');
  if (typeof data['confirmedBy'] !== 'string' || data['confirmedBy'] === '') {
    throw new Error('supply rules must record who confirmed them (confirmedBy)');
  }
  const counts = obj(data['playerCounts'], 'playerCounts');
  const minPlayers = int(counts['min'], 'playerCounts.min', 2, 6);
  const maxPlayers = int(counts['max'], 'playerCounts.max', minPlayers, 6);
  const copper = obj(data['copper'], 'copper');
  if (data['tieBreak'] !== 'fewer-turns') {
    throw new Error('tieBreak must be "fewer-turns"');
  }
  return {
    minPlayers,
    maxPlayers,
    copperTotal: int(copper['total'], 'copper.total', 1, 999),
    copperStartingPerPlayer: int(copper['startingPerPlayer'], 'copper.startingPerPlayer', 0, 20),
    silver: int(data['silver'], 'silver', 1, 999),
    gold: int(data['gold'], 'gold', 1, 999),
    potion: int(data['potion'], 'potion', 1, 999),
    platinum: int(data['platinum'], 'platinum', 1, 999),
    victoryPile: byPlayers(data['victoryPile'], 'victoryPile', minPlayers, maxPlayers),
    colony: byPlayers(data['colony'], 'colony', minPlayers, maxPlayers),
    curse: byPlayers(data['curse'], 'curse', minPlayers, maxPlayers),
    kingdomPile: int(data['kingdomPile'], 'kingdomPile', 1, 99),
    emptyPilesEndingGame: int(data['emptyPilesEndingGame'], 'emptyPilesEndingGame', 1, 10),
    endingPiles: strings(data['endingPiles'], 'endingPiles'),
    notSupplyTypes: new Set(strings(data['notSupplyTypes'], 'notSupplyTypes')),
    notSupplyCards: new Set(strings(data['notSupplyCards'], 'notSupplyCards')),
    manualPileTypes: new Set(strings(data['manualPileTypes'], 'manualPileTypes')),
    manualPileCards: new Set(strings(data['manualPileCards'], 'manualPileCards')),
    needsExtraPileTypes: new Set(strings(data['needsExtraPileTypes'], 'needsExtraPileTypes')),
  };
}

export async function loadRules(dir: string): Promise<Rules> {
  return parseRules(JSON.parse(await readFile(path.join(dir, 'supply-rules.json'), 'utf8')));
}
