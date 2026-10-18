import type { Rules } from '../games/rules.js';

export interface Clause {
  sql: string;
  params: unknown[];
}

/** Cards that can be a kingdom pile in a game at all (the same test the game tracker applies). */
export function playableClause(rules: Rules): Clause {
  return {
    sql: `c.kingdom = 1 AND c.cost_coins IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM card_types ct WHERE ct.card_id = c.id AND ct.type IN (?))
      AND c.name_en NOT IN (?)`,
    params: [[...rules.notSupplyTypes], [...rules.notSupplyCards]],
  };
}

/** Cards a random draw may pick: playable cards that are ordinary piles needing nothing extra. */
export function drawPoolClause(rules: Rules): Clause {
  const base = playableClause(rules);
  return {
    sql: `${base.sql}
      AND NOT EXISTS (SELECT 1 FROM card_types cx WHERE cx.card_id = c.id AND cx.type IN (?))
      AND c.name_en NOT IN (?)`,
    params: [
      ...base.params,
      [...rules.manualPileTypes, ...rules.needsExtraPileTypes],
      [...rules.manualPileCards],
    ],
  };
}
