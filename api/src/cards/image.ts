/**
 * File name (without extension) under which a card's picture is expected in the cards folder:
 * the English name in lower case, apostrophes dropped and every other run of characters that
 * are not letters or digits replaced by a single dash. "King's Court" becomes "kings-court".
 */
export function imageSlug(nameEn: string): string {
  return nameEn
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
