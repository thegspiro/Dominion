import { api, byId, currentUser } from './api.js';
import { button, el } from './dom.js';

interface CardView {
  id: string;
  name: { en: string; de: string };
  imageSlug: string;
  cost: { price: string; coins: number | null; potions: number; debt: number; variable: boolean };
  kingdom: boolean;
  types: string[];
  editions: { id: string; name: string }[];
}

interface CardList {
  total: number;
  limit: number;
  offset: number;
  items: CardView[];
}

const PAGE_SIZE = 50;
const form = byId<HTMLFormElement>('filters');
const editionSelect = byId<HTMLSelectElement>('edition');
const typeSelect = byId<HTMLSelectElement>('type');
const results = byId<HTMLUListElement>('results');
const summary = byId<HTMLElement>('summary');
const moreButton = byId<HTMLButtonElement>('more');
const message = byId<HTMLElement>('message');

let loaded = 0;

function describeCost(cost: CardView['cost']): string {
  const parts: string[] = [];
  if (cost.debt > 0) {
    parts.push(`${cost.debt} debt`);
  } else if (cost.coins !== null) {
    parts.push(`$${cost.coins}${cost.variable ? '*' : ''}`);
  } else {
    parts.push('no fixed cost');
  }
  if (cost.potions > 0) {
    parts.push('potion');
  }
  return parts.join(' + ');
}

const PICTURE_TYPES = ['webp', 'jpg', 'png'];

/** Shows the picture from the cards folder, trying each supported file type; says so when there is none. */
function showPicture(card: CardView, holder: HTMLElement): void {
  holder.replaceChildren();
  let attempt = 0;
  const image = el('img', { className: 'card-picture', attrs: { alt: `${card.name.en} card`, loading: 'lazy' } });
  image.addEventListener('error', () => {
    attempt += 1;
    if (attempt < PICTURE_TYPES.length) {
      image.src = `/cards/${card.imageSlug}.${PICTURE_TYPES[attempt]}`;
    } else {
      holder.replaceChildren(
        el('p', { className: 'hint', text: `No picture found. Add ${card.imageSlug}.webp, .jpg or .png to your cards folder.` }),
      );
    }
  });
  image.src = `/cards/${card.imageSlug}.${PICTURE_TYPES[0]}`;
  holder.append(image);
}

function renderCard(card: CardView): HTMLLIElement {
  const item = document.createElement('li');
  const name = document.createElement('strong');
  name.textContent = card.name.en;
  const cost = document.createElement('span');
  cost.className = 'cost';
  cost.textContent = describeCost(card.cost);
  const detail = document.createElement('div');
  detail.className = 'detail';
  const editions = card.editions.map((e) => e.name).join(', ');
  detail.textContent = `${card.types.join(' - ')}${editions ? ` | ${editions}` : ''}${card.kingdom ? '' : ' | not a kingdom card'}`;
  const top = document.createElement('div');
  top.className = 'top';
  top.append(name, cost);
  const holder = el('div', { className: 'picture' });
  let shown = false;
  const toggle = button('Show picture', () => {
    shown = !shown;
    toggle.textContent = shown ? 'Hide picture' : 'Show picture';
    if (shown) {
      showPicture(card, holder);
    } else {
      holder.replaceChildren();
    }
  }, { aria: `Show or hide the picture of ${card.name.en}` });
  item.append(top, detail, toggle, holder);
  return item;
}

function queryString(offset: number): string {
  const data = new FormData(form);
  const params = new URLSearchParams();
  for (const key of ['q', 'edition', 'type'] as const) {
    const value = String(data.get(key) ?? '').trim();
    if (value !== '') {
      params.set(key, value);
    }
  }
  if (data.get('kingdom') !== null) {
    params.set('kingdom', 'true');
  }
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(offset));
  return params.toString();
}

async function load(reset: boolean): Promise<void> {
  message.textContent = '';
  if (reset) {
    results.replaceChildren();
    loaded = 0;
  }
  const res = await api<CardList>(`/cards?${queryString(loaded)}`);
  if (res.status === 401) {
    window.location.replace('/login.html');
    return;
  }
  if (!res.ok || !res.body) {
    message.textContent = 'Could not load cards. Please try again.';
    return;
  }
  for (const card of res.body.items) {
    results.append(renderCard(card));
  }
  loaded += res.body.items.length;
  summary.textContent =
    res.body.total === 0 ? 'No cards match.' : `Showing ${loaded} of ${res.body.total} cards`;
  moreButton.hidden = loaded >= res.body.total;
}

async function fillOptions(): Promise<void> {
  const [editions, types] = await Promise.all([
    api<{ editions: { id: string; name: { en: string } }[] }>('/editions'),
    api<{ types: string[] }>('/card-types'),
  ]);
  for (const edition of editions.body?.editions ?? []) {
    editionSelect.append(new Option(edition.name.en, edition.id));
  }
  for (const type of types.body?.types ?? []) {
    typeSelect.append(new Option(type, type));
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void load(true);
});
moreButton.addEventListener('click', () => void load(false));

void (async () => {
  const user = await currentUser();
  if (!user) {
    window.location.replace('/login.html');
    return;
  }
  await fillOptions();
  await load(true);
})();
