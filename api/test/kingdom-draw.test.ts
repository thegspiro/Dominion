import { describe, expect, it } from 'vitest';
import { drawCards, type DrawCard } from '../src/kingdoms/draw.js';

const card = (name: string): DrawCard => ({ id: `id-${name}`, nameEn: name });
const pool = (n: number): DrawCard[] => Array.from({ length: n }, (_, i) => card(`Pool ${i}`));

/** Small deterministic generator so shuffles are repeatable. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe('drawCards', () => {
  it('draws the requested number of distinct cards', () => {
    const result = drawCards(pool(30), [], 10, seeded(1));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cards).toHaveLength(10);
      expect(new Set(result.cards.map((c) => c.id)).size).toBe(10);
    }
  });

  it('keeps every fixed card and fills the rest from the pool', () => {
    const fixed = [card('Locked A'), card('Locked B')];
    const result = drawCards(pool(30), fixed, 10, seeded(2));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cards.slice(0, 2)).toEqual(fixed);
      expect(result.cards).toHaveLength(10);
    }
  });

  it('never repeats a name already taken by a fixed card or earlier in the pool', () => {
    const fixed = [card('Village')];
    const crowded = [card('Village'), card('Village'), card('Smithy'), card('Smithy'), card('Market')];
    const result = drawCards(crowded, fixed, 3, seeded(3));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cards.map((c) => c.nameEn).sort()).toEqual(['Market', 'Smithy', 'Village']);
    }
  });

  it('collapses fixed cards that share a name', () => {
    const result = drawCards(pool(5), [card('Dup'), { id: 'other', nameEn: 'Dup' }], 3, seeded(4));
    expect(result.ok && result.cards.filter((c) => c.nameEn === 'Dup')).toHaveLength(1);
  });

  it('reports too many fixed cards and a pool that is too small', () => {
    expect(drawCards(pool(30), pool(11).map((c) => ({ ...c, nameEn: `F${c.nameEn}` })), 10, seeded(5))).toEqual({
      ok: false,
      reason: 'too_many_fixed',
    });
    expect(drawCards(pool(9), [], 10, seeded(6))).toEqual({ ok: false, reason: 'not_enough_cards' });
    expect(drawCards(pool(8), [card('A'), card('B')], 11, seeded(7))).toEqual({ ok: false, reason: 'not_enough_cards' });
    expect(drawCards(pool(8), [card('A'), card('B')], 10, seeded(7))).toMatchObject({ ok: true });
    expect(drawCards(pool(7), [card('A'), card('B')], 10, seeded(7))).toEqual({ ok: false, reason: 'not_enough_cards' });
  });

  it('is repeatable for a seed and varies between seeds', () => {
    const run = (seed: number) => {
      const r = drawCards(pool(40), [], 10, seeded(seed));
      return r.ok ? r.cards.map((c) => c.id).join() : '';
    };
    expect(run(9)).toBe(run(9));
    expect(new Set([1, 2, 3, 4, 5, 6].map(run)).size).toBeGreaterThan(1);
  });

  it('picks every pool card equally often (no position bias)', () => {
    const counts = new Map<string, number>();
    const rand = seeded(11);
    const cards = pool(12);
    for (let i = 0; i < 6000; i += 1) {
      const r = drawCards(cards, [], 5, rand);
      if (r.ok) {
        for (const c of r.cards) {
          counts.set(c.id, (counts.get(c.id) ?? 0) + 1);
        }
      }
    }
    for (const n of counts.values()) {
      expect(n).toBeGreaterThan(2250);
      expect(n).toBeLessThan(2750);
    }
    expect(counts.size).toBe(12);
  });

  it('does not change its inputs', () => {
    const cards = pool(15);
    const fixed = [card('Keep')];
    const before = JSON.stringify([cards, fixed]);
    drawCards(cards, fixed, 10, seeded(12));
    expect(JSON.stringify([cards, fixed])).toBe(before);
  });
});
