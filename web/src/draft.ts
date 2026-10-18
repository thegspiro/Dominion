export interface DraftCard {
  id: string;
  name: { en: string };
  cost: { coins: number | null; potions: number; debt: number };
  types: string[];
}

const KEY = 'dominion.kingdomDraft';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Hands the chosen kingdom to the new-game page. Browser storage may be unavailable, so failure is reported. */
export function saveDraft(cards: DraftCard[]): boolean {
  try {
    const slim = cards.map((c) => ({ id: c.id, name: { en: c.name.en }, cost: c.cost, types: c.types }));
    window.sessionStorage.setItem(KEY, JSON.stringify(slim));
    return true;
  } catch {
    return false;
  }
}

function isDraftCard(value: unknown): value is DraftCard {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const card = value as Partial<DraftCard>;
  const cost = card.cost;
  return (
    typeof card.id === 'string' &&
    UUID.test(card.id) &&
    typeof card.name?.en === 'string' &&
    card.name.en.length > 0 &&
    card.name.en.length <= 64 &&
    typeof cost === 'object' &&
    cost !== null &&
    (cost.coins === null || typeof cost.coins === 'number') &&
    typeof cost.potions === 'number' &&
    typeof cost.debt === 'number' &&
    Array.isArray(card.types) &&
    card.types.every((t) => typeof t === 'string')
  );
}

/** Reads and clears the handed-over kingdom. Storage is untrusted, so anything unexpected yields null. */
export function takeDraft(): DraftCard[] | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    window.sessionStorage.removeItem(KEY);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length <= 10 && parsed.every(isDraftCard) ? parsed : null;
  } catch {
    return null;
  }
}
