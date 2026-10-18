import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyCorrections, loadDataset, type Card } from '../src/cards/dataset.js';
import { parsePrice } from '../src/cards/price.js';

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/data');

describe('parsePrice', () => {
  it('parses every notation in the data', () => {
    expect(parsePrice('3')).toEqual({ coins: 3, potions: 0, debt: 0, variable: false });
    expect(parsePrice('0')).toEqual({ coins: 0, potions: 0, debt: 0, variable: false });
    expect(parsePrice('2P')).toEqual({ coins: 2, potions: 1, debt: 0, variable: false });
    expect(parsePrice('P')).toEqual({ coins: 0, potions: 1, debt: 0, variable: false });
    expect(parsePrice('D8')).toEqual({ coins: 0, potions: 0, debt: 8, variable: false });
    expect(parsePrice('8*')).toEqual({ coins: 8, potions: 0, debt: 0, variable: true });
    expect(parsePrice('*')).toEqual({ coins: null, potions: 0, debt: 0, variable: true });
  });

  it('rejects notations it does not know', () => {
    for (const bad of ['', 'abc', '-1', '3D', 'DP', '3 ', '**', '1.5']) {
      expect(() => parsePrice(bad)).toThrow('Unrecognised price');
    }
  });
});

const card = (nameEn: string, types: string[]): Card => ({
  id: '00000000-0000-4000-8000-000000000000',
  nameEn,
  nameDe: nameEn,
  price: '3',
  cost: { coins: 3, potions: 0, debt: 0, variable: false },
  types,
  kingdom: true,
});

describe('applyCorrections', () => {
  const correction = { name: 'Island', expectedMatches: 1, wasTypes: ['Victory'], types: ['Action', 'Victory'] };

  it('replaces the types on a copy and leaves the input untouched', () => {
    const input = [card('Island', ['Victory']), card('Village', ['Action'])];
    const { cards, applied } = applyCorrections(input, [correction]);
    expect(cards[0]?.types).toEqual(['Action', 'Victory']);
    expect(cards[1]?.types).toEqual(['Action']);
    expect(input[0]?.types).toEqual(['Victory']);
    expect(applied).toEqual(['Island']);
  });

  it('fails when the card is missing or matched the wrong number of times', () => {
    expect(() => applyCorrections([card('Village', ['Action'])], [correction])).toThrow('expected 1 card(s) but found 0');
    expect(() => applyCorrections([card('Island', ['Victory']), card('Island', ['Victory'])], [correction])).toThrow(
      'found 2',
    );
  });

  it('fails when the card no longer has the types the correction replaces', () => {
    expect(() => applyCorrections([card('Island', ['Action', 'Victory'])], [correction])).toThrow('expected types');
  });
});

describe('card snapshot', () => {
  it('loads, validates and corrects the committed data', async () => {
    const dataset = await loadDataset(dataDir);
    expect(dataset.cards).toHaveLength(852);
    expect(dataset.editions).toHaveLength(24);
    expect(dataset.appliedCorrections).toEqual(['Ambassador', 'Island']);

    const byName = (name: string) => dataset.cards.find((c) => c.nameEn === name);
    expect(byName('Ambassador')?.types.sort()).toEqual(['Action', 'Attack']);
    expect(byName('Island')?.types.sort()).toEqual(['Action', 'Victory']);
    expect(byName('Village')?.cost.coins).toBe(3);
    expect(byName('Transmute')?.cost).toEqual({ coins: 0, potions: 1, debt: 0, variable: false });
    expect(byName('Annex')?.cost.debt).toBe(8);
  });

  it('gives every card at least one edition', async () => {
    const dataset = await loadDataset(dataDir);
    const inEdition = new Set(dataset.editions.flatMap((e) => e.cardIds));
    expect(dataset.cards.filter((c) => !inEdition.has(c.id))).toEqual([]);
  });
});
