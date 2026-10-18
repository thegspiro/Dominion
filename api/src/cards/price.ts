export interface Cost {
  coins: number | null;
  potions: number;
  debt: number;
  variable: boolean;
}

/**
 * Parses the price notation used by the card data:
 *   "3"   coins            "2P" / "P"  coins and one potion
 *   "D8"  debt             "8*" / "3*" coins with a variable or special cost
 *   "*"   no fixed coin cost
 * Anything else is rejected so new notations are noticed instead of misread.
 */
export function parsePrice(price: string): Cost {
  let match = /^(\d+)$/.exec(price);
  if (match) {
    return { coins: Number(match[1]), potions: 0, debt: 0, variable: false };
  }
  match = /^(\d*)P$/.exec(price);
  if (match) {
    return { coins: match[1] === '' ? 0 : Number(match[1]), potions: 1, debt: 0, variable: false };
  }
  match = /^D(\d+)$/.exec(price);
  if (match) {
    return { coins: 0, potions: 0, debt: Number(match[1]), variable: false };
  }
  match = /^(\d+)\*$/.exec(price);
  if (match) {
    return { coins: Number(match[1]), potions: 0, debt: 0, variable: true };
  }
  if (price === '*') {
    return { coins: null, potions: 0, debt: 0, variable: true };
  }
  throw new Error(`Unrecognised price "${price}"`);
}
