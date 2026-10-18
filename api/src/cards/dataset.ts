import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parsePrice, type Cost } from './price.js';

export interface Edition {
  id: string;
  nameEn: string;
  nameDe: string;
  releaseDate: string;
  cardIds: string[];
}

export interface Card {
  id: string;
  nameEn: string;
  nameDe: string;
  price: string;
  cost: Cost;
  types: string[];
  kingdom: boolean;
}

export interface Dataset {
  editions: Edition[];
  cards: Card[];
  appliedCorrections: string[];
}

interface Correction {
  name: string;
  expectedMatches: number;
  wasTypes: string[];
  types: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Json = Record<string, unknown>;

function asObject(value: unknown, where: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  return value as Json;
}

function asString(value: unknown, where: string, maxLength: number): string {
  if (typeof value !== 'string' || value === '' || value.length > maxLength) {
    throw new Error(`${where} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function asStringArray(value: unknown, where: string, maxLength: number): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${where} must be an array`);
  }
  return value.map((item, index) => asString(item, `${where}[${index}]`, maxLength));
}

function asId(value: unknown, where: string): string {
  const id = asString(value, where, 36);
  if (!UUID.test(id)) {
    throw new Error(`${where} must be a UUID, got "${id}"`);
  }
  return id;
}

function parseCards(raw: unknown): Card[] {
  if (!Array.isArray(raw)) {
    throw new Error('cards must be an array');
  }
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const where = `cards[${index}]`;
    const obj = asObject(entry, where);
    const id = asId(obj['id'], `${where}.id`);
    if (seen.has(id)) {
      throw new Error(`Duplicate card id ${id}`);
    }
    seen.add(id);
    const price = asString(obj['price'], `${where}.price`, 8);
    const types = asStringArray(obj['type'], `${where}.type`, 32);
    if (types.length === 0) {
      throw new Error(`${where}.type must not be empty`);
    }
    if (typeof obj['kingdom'] !== 'boolean') {
      throw new Error(`${where}.kingdom must be a boolean`);
    }
    return {
      id,
      nameEn: asString(obj['en'], `${where}.en`, 64),
      nameDe: asString(obj['de'], `${where}.de`, 64),
      price,
      cost: parsePrice(price),
      types: [...new Set(types)],
      kingdom: obj['kingdom'],
    };
  });
}

function parseEditions(raw: unknown, cardIds: Set<string>): Edition[] {
  if (!Array.isArray(raw)) {
    throw new Error('editions must be an array');
  }
  return raw.map((entry, index) => {
    const where = `editions[${index}]`;
    const obj = asObject(entry, where);
    const ids = asStringArray(obj['card_ids'], `${where}.card_ids`, 36);
    for (const id of ids) {
      if (!cardIds.has(id)) {
        throw new Error(`${where} refers to unknown card ${id}`);
      }
    }
    return {
      id: asId(obj['id'], `${where}.id`),
      nameEn: asString(obj['edition_en'], `${where}.edition_en`, 80),
      nameDe: asString(obj['edition_de'], `${where}.edition_de`, 80),
      releaseDate: asString(obj['release_date'], `${where}.release_date`, 16),
      cardIds: [...new Set(ids)],
    };
  });
}

function parseCorrections(raw: unknown): Correction[] {
  const list = asObject(raw, 'corrections file')['corrections'];
  if (!Array.isArray(list)) {
    throw new Error('corrections must be an array');
  }
  return list.map((entry, index) => {
    const where = `corrections[${index}]`;
    const obj = asObject(entry, where);
    const expectedMatches = obj['expectedMatches'];
    if (!Number.isInteger(expectedMatches) || (expectedMatches as number) < 1) {
      throw new Error(`${where}.expectedMatches must be a positive integer`);
    }
    return {
      name: asString(obj['name'], `${where}.name`, 64),
      expectedMatches: expectedMatches as number,
      wasTypes: asStringArray(obj['wasTypes'], `${where}.wasTypes`, 32),
      types: asStringArray(obj['types'], `${where}.types`, 32),
    };
  });
}

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Applies the corrections to a copy of the cards. A correction must match the
 * expected number of cards and the types it says it replaces, so a stale
 * correction fails loudly when the snapshot changes.
 */
export function applyCorrections(cards: Card[], corrections: Correction[]): { cards: Card[]; applied: string[] } {
  const result = cards.map((card) => ({ ...card }));
  const applied: string[] = [];
  for (const correction of corrections) {
    const matches = result.filter((card) => card.nameEn === correction.name);
    if (matches.length !== correction.expectedMatches) {
      throw new Error(
        `Correction for "${correction.name}" expected ${correction.expectedMatches} card(s) but found ${matches.length}`,
      );
    }
    for (const card of matches) {
      if (!sameSet(card.types, correction.wasTypes)) {
        throw new Error(
          `Correction for "${correction.name}" expected types [${correction.wasTypes.join(', ')}] but the card has [${card.types.join(', ')}]`,
        );
      }
      card.types = [...new Set(correction.types)];
    }
    applied.push(correction.name);
  }
  return { cards: result, applied };
}

export async function loadDataset(dir: string): Promise<Dataset> {
  const data = asObject(JSON.parse(await readFile(path.join(dir, 'dominion.json'), 'utf8')), 'dominion.json');
  const corrections = parseCorrections(JSON.parse(await readFile(path.join(dir, 'corrections.json'), 'utf8')));
  const parsedCards = parseCards(data['cards']);
  const editions = parseEditions(data['editions'], new Set(parsedCards.map((card) => card.id)));
  const { cards, applied } = applyCorrections(parsedCards, corrections);
  return { editions, cards, appliedCorrections: applied };
}
