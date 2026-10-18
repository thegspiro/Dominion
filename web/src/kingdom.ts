import { api, byId, currentUser, type ApiResult } from './api.js';
import { button, el } from './dom.js';
import { saveDraft, type DraftCard } from './draft.js';

interface CardView extends DraftCard {
  imageSlug: string;
}

interface Preference {
  id: string;
  name: { en: string };
  preference: 'ban' | 'require';
}

interface SavedKingdom {
  id: string;
  name: string;
  cardNames: string[];
}

const KINGDOM_SIZE = 10;
const AVOID_TYPES = ['Attack', 'Duration', 'Reaction', 'Reserve', 'Victory', 'Treasure', 'Looter'];
const MAX_COST = 11;

const editionsBox = byId<HTMLElement>('editions');
const editionsSummary = byId<HTMLElement>('editions-summary');
const avoidBox = byId<HTMLElement>('avoid');
const minCost = byId<HTMLSelectElement>('min-cost');
const maxCost = byId<HTMLSelectElement>('max-cost');
const randomize = byId<HTMLButtonElement>('randomize');
const summary = byId<HTMLElement>('summary');
const kingdomList = byId<HTMLUListElement>('kingdom');
const nameInput = byId<HTMLInputElement>('kingdom-name');
const saveButton = byId<HTMLButtonElement>('save');
const playButton = byId<HTMLButtonElement>('play');
const savedList = byId<HTMLUListElement>('saved');
const savedEmpty = byId<HTMLElement>('saved-empty');
const bannedList = byId<HTMLUListElement>('banned');
const requiredList = byId<HTMLUListElement>('required');
const listSearch = byId<HTMLInputElement>('list-search');
const listResults = byId<HTMLUListElement>('list-results');
const message = byId<HTMLElement>('message');

let kingdom: CardView[] = [];
const locked = new Set<string>();
let preferences: Preference[] = [];
const chosenEditions = new Set<string>();

const MESSAGES: Record<string, string> = {
  invalid_cost_range: 'The cheapest card cannot cost more than the most expensive one.',
  not_enough_cards: 'Not enough cards match these filters to fill the kingdom. Loosen them and try again.',
  too_many_fixed: 'Locked and always-included cards add up to more than ten. Unlock some or shorten your always-include list.',
  not_a_supply_card: 'One of those cards cannot be used as a kingdom pile.',
  too_many_required: 'You can always include at most ten cards.',
  too_many_preferences: 'Your lists are full. Remove a card first.',
  name_taken: 'You already have a kingdom with that name.',
  invalid_name: 'Give the kingdom a name without special characters.',
  too_many_kingdoms: 'You have reached the limit of saved kingdoms. Delete one first.',
  duplicate_card: 'The same card is in the kingdom twice.',
};

function say(text: string): void {
  message.textContent = text;
}

function explain(res: ApiResult<{ error?: string; reason?: string }>, fallback: string): string {
  const key = res.body?.reason ?? res.body?.error ?? '';
  return MESSAGES[key] ?? fallback;
}

function costText(card: DraftCard): string {
  const { coins, potions, debt } = card.cost;
  const base = debt > 0 ? `${debt} debt` : coins === null ? '' : `$${coins}`;
  return `${base}${potions > 0 ? ' + potion' : ''}`.trim();
}

function preferenceOf(cardId: string): 'ban' | 'require' | null {
  return preferences.find((p) => p.id === cardId)?.preference ?? null;
}

function selectedEditions(): string[] {
  return [...chosenEditions];
}

async function setPreference(cardId: string, preference: 'ban' | 'require' | null): Promise<void> {
  say('');
  const res = await api<{ preferences: Preference[]; error?: string; reason?: string }>(`/card-preferences/${cardId}`, 'PUT', {
    preference,
  });
  if (!res.ok || !res.body) {
    say(explain(res, 'Could not update your list. Please try again.'));
    return;
  }
  preferences = res.body.preferences;
  if (preference === 'ban') {
    locked.delete(cardId);
  }
  renderAll();
}

function pill(label: string, pressed: boolean, onClick: () => void, aria: string): HTMLButtonElement {
  const node = button(label, onClick, { aria });
  node.setAttribute('aria-pressed', String(pressed));
  return node;
}

function renderKingdom(): void {
  kingdomList.replaceChildren();
  for (const card of kingdom) {
    const pref = preferenceOf(card.id);
    const isLocked = locked.has(card.id);
    const controls = el('div', { className: 'controls' }, [
      pill(isLocked ? 'Locked' : 'Lock', isLocked, () => {
        if (isLocked) {
          locked.delete(card.id);
        } else {
          locked.add(card.id);
        }
        renderAll();
      }, `${isLocked ? 'Unlock' : 'Lock'} ${card.name.en}`),
      pill('Never draw', pref === 'ban', () => void setPreference(card.id, pref === 'ban' ? null : 'ban'), `Never draw ${card.name.en}`),
      pill('Always include', pref === 'require', () => void setPreference(card.id, pref === 'require' ? null : 'require'), `Always include ${card.name.en}`),
    ]);
    const note = pref === 'ban' ? ' | will be replaced next time' : pref === 'require' ? ' | always included' : '';
    kingdomList.append(
      el('li', { className: isLocked ? 'locked' : '' }, [
        el('div', { className: 'top' }, [el('strong', { text: card.name.en }), el('span', { className: 'cost', text: costText(card) })]),
        el('div', { className: 'detail', text: `${card.types.join(' - ')}${note}` }),
        controls,
      ]),
    );
  }
  const lockedNow = kingdom.filter((c) => locked.has(c.id)).length;
  summary.textContent =
    kingdom.length === 0
      ? 'No kingdom yet. Press Randomize.'
      : `${kingdom.length} cards | ${lockedNow} locked, ${Math.max(kingdom.length - lockedNow, 0)} will change on the next Randomize`;
  const complete = kingdom.length === KINGDOM_SIZE;
  saveButton.disabled = !complete;
  playButton.disabled = !complete;
}

function listRow(pref: Preference): HTMLElement {
  return el('li', {}, [
    el('div', { className: 'top' }, [el('strong', { text: pref.name.en })]),
    el('div', { className: 'controls' }, [
      button('Remove', () => void setPreference(pref.id, null), { aria: `Remove ${pref.name.en} from this list` }),
    ]),
  ]);
}

function renderLists(): void {
  const banned = preferences.filter((p) => p.preference === 'ban');
  const required = preferences.filter((p) => p.preference === 'require');
  bannedList.replaceChildren(...(banned.length > 0 ? banned.map(listRow) : [el('li', { text: 'No cards.' })]));
  requiredList.replaceChildren(...(required.length > 0 ? required.map(listRow) : [el('li', { text: 'No cards.' })]));
}

function renderEditions(editions: { id: string; name: { en: string } }[]): void {
  editionsSummary.textContent =
    chosenEditions.size === 0 ? 'Sets to draw from: any' : `Sets to draw from: ${chosenEditions.size} chosen`;
  editionsBox.replaceChildren(
    ...editions.map((e) =>
      pill(e.name.en, chosenEditions.has(e.id), () => {
        if (chosenEditions.has(e.id)) {
          chosenEditions.delete(e.id);
        } else {
          chosenEditions.add(e.id);
        }
        renderEditions(editions);
      }, `Draw from ${e.name.en}`),
    ),
  );
}

function renderAll(): void {
  renderKingdom();
  renderLists();
}

async function doRandomize(): Promise<void> {
  say('');
  randomize.disabled = true;
  const body: Record<string, unknown> = {
    lockedIds: kingdom.filter((c) => locked.has(c.id)).map((c) => c.id),
    excludeTypes: [...avoidBox.querySelectorAll<HTMLInputElement>('input:checked')].map((i) => i.value),
  };
  const editions = selectedEditions();
  if (editions.length > 0) {
    body['editions'] = editions;
  }
  if (minCost.value !== '') {
    body['minCost'] = Number(minCost.value);
  }
  if (maxCost.value !== '') {
    body['maxCost'] = Number(maxCost.value);
  }
  const res = await api<{ items: CardView[]; fixedIds: string[]; error?: string; reason?: string }>('/kingdoms/draw', 'POST', body);
  randomize.disabled = false;
  if (!res.ok || !res.body) {
    say(explain(res, 'Could not draw a kingdom. Please try again.'));
    return;
  }
  kingdom = res.body.items;
  const keep = new Set(kingdom.map((c) => c.id));
  for (const id of [...locked]) {
    if (!keep.has(id)) {
      locked.delete(id);
    }
  }
  renderAll();
}

function startGame(cards: DraftCard[]): void {
  if (!saveDraft(cards)) {
    say('Your browser would not keep the kingdom for the next page. Allow site storage and try again.');
    return;
  }
  window.location.assign('/new-game.html?from=kingdom');
}

async function refreshSaved(): Promise<void> {
  const res = await api<{ kingdoms: SavedKingdom[] }>('/kingdoms');
  const list = res.body?.kingdoms ?? [];
  savedEmpty.hidden = list.length > 0;
  savedList.replaceChildren(
    ...list.map((k) => {
      const open = async (andPlay: boolean): Promise<void> => {
        say('');
        const loaded = await api<{ items: CardView[] }>(`/kingdoms/${k.id}`);
        if (!loaded.ok || !loaded.body) {
          say('Could not open that kingdom. Please try again.');
          return;
        }
        if (andPlay) {
          startGame(loaded.body.items);
          return;
        }
        kingdom = loaded.body.items;
        locked.clear();
        nameInput.value = k.name;
        renderAll();
      };
      return el('li', {}, [
        el('div', { className: 'top' }, [el('strong', { text: k.name })]),
        el('div', { className: 'detail', text: k.cardNames.join(', ') }),
        el('div', { className: 'controls' }, [
          button('Load', () => void open(false), { aria: `Load ${k.name}` }),
          button('Start game', () => void open(true), { aria: `Start a game with ${k.name}` }),
          button('Delete', () => {
            if (window.confirm(`Delete the kingdom "${k.name}"?`)) {
              void (async () => {
                const res = await api(`/kingdoms/${k.id}`, 'DELETE');
                if (!res.ok) {
                  say('Could not delete that kingdom. Please try again.');
                  return;
                }
                await refreshSaved();
              })();
            }
          }, { aria: `Delete ${k.name}` }),
        ]),
      ]);
    }),
  );
}

async function save(): Promise<void> {
  say('');
  const name = nameInput.value.trim();
  if (name === '') {
    say('Give the kingdom a name first.');
    return;
  }
  const res = await api<{ error?: string; reason?: string }>('/kingdoms', 'POST', { name, cardIds: kingdom.map((c) => c.id) });
  if (!res.ok) {
    say(explain(res, 'Could not save the kingdom. Please try again.'));
    return;
  }
  say('');
  await refreshSaved();
  summary.textContent = `Saved "${name}".`;
}

let searchTimer: number | undefined;
async function runListSearch(): Promise<void> {
  listResults.replaceChildren();
  const text = listSearch.value.trim();
  if (text === '') {
    return;
  }
  const params = new URLSearchParams({ q: text, kingdom: 'true', limit: '6' });
  const res = await api<{ items: CardView[] }>(`/cards?${params.toString()}`);
  for (const card of res.body?.items ?? []) {
    const pref = preferenceOf(card.id);
    listResults.append(
      el('li', {}, [
        el('div', { className: 'top' }, [el('strong', { text: card.name.en }), el('span', { className: 'cost', text: costText(card) })]),
        el('div', { className: 'controls' }, [
          pill('Never draw', pref === 'ban', () => void setPreference(card.id, pref === 'ban' ? null : 'ban').then(runListSearch), `Never draw ${card.name.en}`),
          pill('Always include', pref === 'require', () => void setPreference(card.id, pref === 'require' ? null : 'require').then(runListSearch), `Always include ${card.name.en}`),
        ]),
      ]),
    );
  }
}

randomize.addEventListener('click', () => void doRandomize());
saveButton.addEventListener('click', () => void save());
playButton.addEventListener('click', () => startGame(kingdom));
listSearch.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void runListSearch(), 250);
});

void (async () => {
  if (!(await currentUser())) {
    window.location.replace('/login.html');
    return;
  }
  for (let cost = 0; cost <= MAX_COST; cost += 1) {
    minCost.append(new Option(`$${cost}`, String(cost)));
    maxCost.append(new Option(`$${cost}`, String(cost)));
  }
  avoidBox.replaceChildren(
    ...AVOID_TYPES.map((type) =>
      el('label', { className: 'check' }, [el('input', { attrs: { type: 'checkbox', value: type } }), ` ${type}`]),
    ),
  );
  const [editions, prefs] = await Promise.all([
    api<{ editions: { id: string; name: { en: string } }[] }>('/editions'),
    api<{ preferences: Preference[] }>('/card-preferences'),
  ]);
  renderEditions(editions.body?.editions ?? []);
  preferences = prefs.body?.preferences ?? [];
  renderAll();
  await refreshSaved();
})();
