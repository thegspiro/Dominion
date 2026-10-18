import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadDataset } from '../src/cards/dataset.js';
import { imageSlug } from '../src/cards/image.js';

describe('imageSlug', () => {
  it.each([
    ['Copper', 'copper'],
    ["King's Court", 'kings-court'],
    ['King’s Court', 'kings-court'],
    ["Philosopher's Stone", 'philosophers-stone'],
    ['Death Cart', 'death-cart'],
    ['Coin of the Realm', 'coin-of-the-realm'],
    ['  Walled   Village ', 'walled-village'],
    ['Bandit Fort', 'bandit-fort'],
    ['Café', 'cafe'],
  ])('%s -> %s', (name, slug) => {
    expect(imageSlug(name)).toBe(slug);
  });

  it('only produces file-name-safe slugs for every card in the data', async () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/data');
    const dataset = await loadDataset(dir);
    for (const card of dataset.cards) {
      expect(imageSlug(card.nameEn), card.nameEn).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });
});
