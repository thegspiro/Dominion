export interface DrawCard {
  id: string;
  nameEn: string;
}

export type DrawResult = { ok: true; cards: DrawCard[] } | { ok: false; reason: 'too_many_fixed' | 'not_enough_cards' };

/**
 * Picks `count` cards: every fixed card (locked or always included) plus random cards from the pool.
 * No two chosen cards share a name, and pool cards never repeat a fixed card.
 * `random` must return a number in [0, 1).
 */
export function drawCards(pool: DrawCard[], fixed: DrawCard[], count: number, random: () => number): DrawResult {
  const names = new Set<string>();
  const keep: DrawCard[] = [];
  for (const card of fixed) {
    if (!names.has(card.nameEn)) {
      names.add(card.nameEn);
      keep.push(card);
    }
  }
  if (keep.length > count) {
    return { ok: false, reason: 'too_many_fixed' };
  }

  const candidates: DrawCard[] = [];
  for (const card of pool) {
    if (!names.has(card.nameEn)) {
      names.add(card.nameEn);
      candidates.push(card);
    }
  }
  const needed = count - keep.length;
  if (candidates.length < needed) {
    return { ok: false, reason: 'not_enough_cards' };
  }

  for (let i = candidates.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j] as DrawCard, candidates[i] as DrawCard];
  }
  return { ok: true, cards: [...keep, ...candidates.slice(0, needed)] };
}
