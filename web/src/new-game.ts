import { api, byId, currentUser } from './api.js';
import { button, el } from './dom.js';
import { takeDraft } from './draft.js';

interface CardView {
  id: string;
  name: { en: string };
  cost: { coins: number | null; potions: number; debt: number };
  types: string[];
}

const KINGDOM_SIZE = 10;
const playerCount = byId<HTMLSelectElement>('player-count');
const playerNames = byId<HTMLElement>('player-names');
const kingdomList = byId<HTMLUListElement>('kingdom');
const kingdomCount = byId<HTMLElement>('kingdom-count');
const editionSelect = byId<HTMLSelectElement>('random-edition');
const randomButton = byId<HTMLButtonElement>('random');
const search = byId<HTMLInputElement>('card-search');
const results = byId<HTMLUListElement>('search-results');
const prosperity = byId<HTMLInputElement>('prosperity');
const startButton = byId<HTMLButtonElement>('start');
const message = byId<HTMLElement>('message');

let kingdom: CardView[] = [];

const ERRORS: Record<string, string> = {
  duplicate_player_name: 'Each player needs a different name.',
  invalid_player_name: 'Player names must be 1 to 32 characters.',
  not_a_supply_card: 'One of the chosen cards cannot be a kingdom pile (for example an Event, Landmark or non-supply card). Replace it.',
  duplicate_kingdom_card: 'The same card is chosen twice.',
  unknown_card: 'One of the chosen cards is not available as a kingdom card.',
  not_enough_cards: 'Not enough cards match to draw ten. Try another edition.',
};

function describe(card: CardView): string {
  const cost = card.cost.debt > 0 ? `${card.cost.debt} debt` : card.cost.coins === null ? '' : `$${card.cost.coins}`;
  return `${cost}${card.cost.potions > 0 ? ' + potion' : ''}`.trim();
}

function renderPlayers(): void {
  const count = Number(playerCount.value);
  const previous = [...playerNames.querySelectorAll('input')].map((i) => i.value);
  playerNames.replaceChildren();
  for (let seat = 0; seat < count; seat += 1) {
    const input = el('input', { attrs: { id: `player-${seat}`, type: 'text', maxlength: '32', autocomplete: 'off', required: '' } });
    input.value = previous[seat] ?? `Player ${seat + 1}`;
    playerNames.append(el('label', { text: `Player ${seat + 1} name`, attrs: { for: `player-${seat}` } }), input);
  }
}

function renderKingdom(): void {
  kingdomList.replaceChildren();
  for (const card of kingdom) {
    const remove = button('Remove', () => {
      kingdom = kingdom.filter((c) => c.id !== card.id);
      renderKingdom();
    }, { aria: `Remove ${card.name.en}` });
    kingdomList.append(
      el('li', {}, [
        el('div', { className: 'top' }, [el('strong', { text: card.name.en }), el('span', { className: 'cost', text: describe(card) })]),
        el('div', { className: 'detail', text: card.types.join(' - ') }),
        remove,
      ]),
    );
  }
  kingdomCount.textContent = `${kingdom.length} of ${KINGDOM_SIZE} cards chosen`;
  startButton.disabled = kingdom.length !== KINGDOM_SIZE;
}

async function drawRandom(): Promise<void> {
  message.textContent = '';
  const params = new URLSearchParams({ count: String(KINGDOM_SIZE) });
  if (editionSelect.value !== '') {
    params.append('edition', editionSelect.value);
  }
  const res = await api<{ items: CardView[]; error?: string }>(`/kingdoms/random?${params.toString()}`);
  if (!res.ok || !res.body) {
    message.textContent = ERRORS[res.body?.error ?? ''] ?? 'Could not draw cards. Please try again.';
    return;
  }
  kingdom = res.body.items;
  renderKingdom();
}

let searchTimer: number | undefined;
async function runSearch(): Promise<void> {
  results.replaceChildren();
  const text = search.value.trim();
  if (text === '') {
    return;
  }
  const params = new URLSearchParams({ q: text, kingdom: 'true', limit: '8' });
  const res = await api<{ items: CardView[] }>(`/cards?${params.toString()}`);
  for (const card of res.body?.items ?? []) {
    const chosen = kingdom.some((c) => c.id === card.id);
    const add = button(chosen ? 'Added' : 'Add', () => {
      if (kingdom.length < KINGDOM_SIZE && !kingdom.some((c) => c.id === card.id)) {
        kingdom = [...kingdom, card];
        renderKingdom();
        void runSearch();
      }
    }, { aria: `Add ${card.name.en}`, disabled: chosen || kingdom.length >= KINGDOM_SIZE });
    results.append(
      el('li', {}, [
        el('div', { className: 'top' }, [el('strong', { text: card.name.en }), el('span', { className: 'cost', text: describe(card) })]),
        el('div', { className: 'detail', text: card.types.join(' - ') }),
        add,
      ]),
    );
  }
}

startButton.addEventListener('click', async () => {
  message.textContent = '';
  startButton.disabled = true;
  const players = [...playerNames.querySelectorAll('input')].map((input) => ({ name: input.value.trim() }));
  const res = await api<{ id: string; error?: string; reason?: string }>('/games', 'POST', {
    players,
    cardIds: kingdom.map((c) => c.id),
    prosperityPiles: prosperity.checked,
  });
  if (res.ok && res.body) {
    window.location.assign(`/game.html?id=${encodeURIComponent(res.body.id)}`);
    return;
  }
  const reason = (res.body as { reason?: string } | null)?.reason ?? '';
  message.textContent = ERRORS[reason] ?? 'Could not start the game. Check the player names and the ten cards.';
  startButton.disabled = kingdom.length !== KINGDOM_SIZE;
});

playerCount.addEventListener('change', renderPlayers);
randomButton.addEventListener('click', () => void drawRandom());
search.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void runSearch(), 250);
});

void (async () => {
  if (!(await currentUser())) {
    window.location.replace('/login.html');
    return;
  }
  renderPlayers();
  if (new URLSearchParams(window.location.search).get('from') === 'kingdom') {
    const draft = takeDraft();
    if (draft) {
      kingdom = draft.map((card) => ({ ...card }));
    }
  }
  renderKingdom();
  const editions = await api<{ editions: { id: string; name: { en: string } }[] }>('/editions');
  for (const edition of editions.body?.editions ?? []) {
    editionSelect.append(new Option(edition.name.en, edition.id));
  }
})();
