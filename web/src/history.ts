import { api, byId, currentUser } from './api.js';
import { el } from './dom.js';

type Ending = 'province_empty' | 'colony_empty' | 'piles_empty' | 'ended_early';

interface Tally {
  games: number;
  wins: number;
  losses: number;
  ties: number;
}

interface Stats {
  name: string;
  record: Tally;
  deckGames: number;
  rebuiltGames: number;
  deckCards: { cardId: string; name: string; games: number; wins: number; ties: number; winRate: number; averageCopies: number }[];
  ambiguousGames: number;
  averages: { score: number | null; opponentScore: number | null; turns: number | null };
  headToHead: (Tally & { opponent: string })[];
  endings: Record<Ending, number>;
  cards: { cardId: string; name: string; games: number; wins: number; ties: number; winRate: number }[];
}

interface StatsResponse {
  players: { name: string; games: number }[];
  truncated: boolean;
  minCardGames: number;
  stats: Stats | null;
}

interface HistoryGame {
  id: string;
  endedAt: string;
  turns: number;
  ending: Ending;
  players: { name: string; vp: number; turns: number; winner: boolean }[];
  kingdom: string[];
}

interface HistoryResponse {
  games: HistoryGame[];
  next: string | null;
}

const STORAGE_KEY = 'dominion.statsPlayer';
const ENDING_TEXT: Record<Ending, string> = {
  province_empty: 'Provinces ran out',
  colony_empty: 'Colonies ran out',
  piles_empty: 'Three piles ran out',
  ended_early: 'Ended early by hand',
};

const message = byId<HTMLElement>('message');
const statsArea = byId<HTMLElement>('stats-area');
const playerSelect = byId<HTMLSelectElement>('player');
const notes = byId<HTMLElement>('notes');
const tiles = byId<HTMLElement>('tiles');
const averages = byId<HTMLElement>('averages');
const headToHead = byId<HTMLUListElement>('head-to-head');
const endings = byId<HTMLUListElement>('endings');
const cards = byId<HTMLUListElement>('cards');
const cardsNote = byId<HTMLElement>('cards-note');
const deckNote = byId<HTMLElement>('deck-note');
const deckCards = byId<HTMLUListElement>('deck-cards');
const recent = byId<HTMLUListElement>('recent');
const empty = byId<HTMLElement>('empty');
const more = byId<HTMLButtonElement>('more');

let nextCursor: string | null = null;

function remembered(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function remember(name: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // Storage can be blocked; the choice is simply not kept.
  }
}

const one = (value: number | null): string => (value === null ? 'n/a' : value.toFixed(1));
const percent = (rate: number): string => `${(rate * 100).toFixed(0)}%`;
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

function tile(value: string, label: string): HTMLElement {
  return el('div', { className: 'tile' }, [el('div', { className: 'tile-value', text: value }), el('div', { className: 'tile-label', text: label })]);
}

function row(title: string, right: string, detail: string, rate?: number): HTMLElement {
  const children: Node[] = [el('div', { className: 'top' }, [el('strong', { text: title }), el('span', { className: 'cost', text: right })])];
  if (rate !== undefined) {
    children.push(el('progress', { attrs: { max: '1', value: String(rate), 'aria-label': `${title}: ${percent(rate)}` } }));
  }
  children.push(el('div', { className: 'detail', text: detail }));
  return el('li', {}, children);
}

function showStats(response: StatsResponse): void {
  const stats = response.stats;
  if (!stats) {
    return;
  }
  const { record } = stats;
  tiles.replaceChildren(
    tile(`${record.wins}-${record.losses}-${record.ties}`, 'Wins, losses and shared wins'),
    tile(String(record.games), 'Finished games'),
    tile(record.games === 0 ? 'n/a' : percent(record.wins / record.games), 'Win rate (shared wins not counted)'),
  );
  averages.textContent = `Average score ${one(stats.averages.score)}, opponents ${one(stats.averages.opponentScore)}. Average turns taken ${one(stats.averages.turns)}.`;

  const noteParts: string[] = [];
  if (response.truncated) {
    noteParts.push('Only the most recent 5000 finished games are counted.');
  }
  if (stats.ambiguousGames > 0) {
    noteParts.push(`${plural(stats.ambiguousGames, 'game')} left out because this name was used for more than one player.`);
  }
  notes.textContent = noteParts.join(' ');

  headToHead.replaceChildren(
    ...stats.headToHead.map((h) => row(h.opponent, `${h.wins}-${h.losses}-${h.ties}`, `${plural(h.games, 'game')}: ${h.wins} won, ${h.losses} lost, ${h.ties} tied`)),
  );
  if (stats.headToHead.length === 0) {
    headToHead.replaceChildren(el('li', { text: 'No finished games for this player yet.' }));
  }

  endings.replaceChildren(
    ...(Object.keys(ENDING_TEXT) as Ending[]).map((key) => row(ENDING_TEXT[key], String(stats.endings[key]), plural(stats.endings[key], 'game'))),
  );

  deckNote.textContent = `Share of finished games you won when you took the card from the supply, and how many copies you took on average. Based on ${plural(stats.deckGames, 'game')} with deck data${stats.rebuiltGames > 0 ? `, ${stats.rebuiltGames} rebuilt from the game log (cards given to an opponent are credited to the player whose turn it was)` : ''}. Starting cards are not counted. Shown once you have taken a card in at least ${response.minCardGames} games; ties are not counted as wins.`;
  deckCards.replaceChildren(
    ...stats.deckCards.map((c) =>
      row(c.name, percent(c.winRate), `${plural(c.games, 'game')}, ${c.wins} won, ${c.ties} tied. ${c.averageCopies.toFixed(1)} copies on average`, c.winRate),
    ),
  );
  if (stats.deckCards.length === 0) {
    deckCards.replaceChildren(el('li', { text: `You have not taken a kingdom card in ${response.minCardGames} games with deck data yet.` }));
  }

  cardsNote.textContent = `Share of finished games you won when the card was one of the ten kingdom cards, whether or not you took it. Shown once a card has been in at least ${response.minCardGames} games; ties are not counted as wins.`;
  cards.replaceChildren(
    ...stats.cards.map((c) => row(c.name, percent(c.winRate), `${plural(c.games, 'game')}, ${c.wins} won, ${c.ties} tied`, c.winRate)),
  );
  if (stats.cards.length === 0) {
    cards.replaceChildren(el('li', { text: `No card has been in ${response.minCardGames} games yet.` }));
  }
}

function recentRow(game: HistoryGame): HTMLElement {
  const scores = game.players.map((p) => `${p.name} ${p.vp}${p.winner ? ' (won)' : ''}`).join(', ');
  const link = el('a', { text: scores, attrs: { href: `/game-log.html?id=${encodeURIComponent(game.id)}` } });
  const top = el('div', { className: 'top' }, [el('strong', {}, [link]), el('span', { className: 'cost', text: new Date(game.endedAt).toLocaleDateString() })]);
  const detail = `${plural(game.turns, 'turn')}. ${ENDING_TEXT[game.ending]}. Kingdom: ${game.kingdom.join(', ') || 'none recorded'}`;
  return el('li', {}, [top, el('div', { className: 'detail', text: detail })]);
}

async function loadStats(player?: string): Promise<StatsResponse | null> {
  const res = await api<StatsResponse>(player === undefined ? '/stats' : `/stats?player=${encodeURIComponent(player)}`);
  if (!res.ok || !res.body) {
    message.textContent = 'Could not load your stats. Please try again.';
    return null;
  }
  return res.body;
}

async function loadRecent(): Promise<void> {
  more.disabled = true;
  const query = nextCursor ? `?limit=20&before=${encodeURIComponent(nextCursor)}` : '?limit=20';
  const res = await api<HistoryResponse>(`/history${query}`);
  more.disabled = false;
  if (!res.ok || !res.body) {
    message.textContent = 'Could not load your games. Please try again.';
    return;
  }
  recent.append(...res.body.games.map(recentRow));
  nextCursor = res.body.next;
  more.hidden = nextCursor === null;
  empty.hidden = recent.children.length > 0;
}

async function choose(name: string): Promise<void> {
  remember(name);
  const response = await loadStats(name);
  if (response) {
    showStats(response);
  }
}

more.addEventListener('click', () => void loadRecent());
playerSelect.addEventListener('change', () => void choose(playerSelect.value));

void (async () => {
  if (!(await currentUser())) {
    window.location.replace('/login.html');
    return;
  }
  const first = await loadStats();
  if (!first) {
    return;
  }
  if (first.players.length > 0) {
    const saved = remembered();
    const savedKey = saved?.trim().toLowerCase();
    const initial = first.players.find((p) => p.name.trim().toLowerCase() === savedKey) ?? first.players[0];
    for (const player of first.players) {
      playerSelect.append(el('option', { text: `${player.name} (${plural(player.games, 'game')})`, attrs: { value: player.name } }));
    }
    if (initial) {
      playerSelect.value = initial.name;
      statsArea.hidden = false;
      await choose(initial.name);
    }
  }
  await loadRecent();
})();
