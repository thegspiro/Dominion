import { api, byId, currentUser } from './api.js';
import { el } from './dom.js';

interface GameView {
  id: string;
  status: 'active' | 'finished' | 'abandoned';
  startedAt: string;
  endedAt: string | null;
  players: { seat: number; name: string; vp: number; turnsTaken: number }[];
  piles: { key: string; label: string; kind: string; count: number }[];
  result: { winners: number[]; tiedOnPoints: boolean } | null;
}

interface Deck {
  seat: number;
  name: string;
  cards: { key: string; label: string; count: number }[];
}

interface LogResponse {
  items: LogItem[];
  decks: Deck[];
  cardsSource: 'tracked' | 'rebuilt' | 'none';
}

interface LogItem {
  seq: number;
  at: string;
  turn: number;
  seat: number;
  player: string;
  type: string;
  label?: string;
  quantity?: number;
  count?: number;
  resource?: string;
  delta?: number;
  target?: string;
}

const STATUS_TEXT: Record<GameView['status'], string> = { active: 'In progress', finished: 'Finished', abandoned: 'Abandoned' };

const title = byId<HTMLElement>('title');
const summary = byId<HTMLElement>('summary');
const message = byId<HTMLElement>('message');
const trackerLink = byId<HTMLElement>('tracker-link');
const trackerAnchor = byId<HTMLAnchorElement>('tracker-anchor');
const body = byId<HTMLElement>('body');
const scores = byId<HTMLUListElement>('scores');
const kingdom = byId<HTMLElement>('kingdom');
const decks = byId<HTMLUListElement>('decks');
const decksNote = byId<HTMLElement>('decks-note');
const timeline = byId<HTMLOListElement>('timeline');
const noEvents = byId<HTMLElement>('no-events');

const signed = (value: number): string => (value > 0 ? `+${value}` : String(value));

function describe(item: LogItem): string {
  switch (item.type) {
    case 'take':
      return `${item.player} took ${item.quantity ?? 1} ${item.label ?? 'card'}`;
    case 'return':
      return `${item.player} returned ${item.quantity ?? 1} ${item.label ?? 'card'}`;
    case 'set_pile':
      return `${item.label ?? 'A pile'} was set to ${item.count ?? 0}`;
    case 'resource':
      return `${item.player}: ${signed(item.delta ?? 0)} ${item.resource ?? 'resource'}`;
    case 'vp':
      return `${item.target ?? item.player}: ${signed(item.delta ?? 0)} VP`;
    case 'end_turn':
      return `${item.player} ended the turn`;
    case 'finish':
      return 'The game was finished';
    case 'abandon':
      return 'The game was abandoned';
    default:
      return item.type;
  }
}

const DECK_NOTE: Record<LogResponse['cardsSource'], string> = {
  tracked: 'Cards taken from the supply. Starting cards are not counted.',
  rebuilt: 'Rebuilt from the game log. Cards given to an opponent are listed under the player whose turn it was. Starting cards are not counted.',
  none: 'Decks were not tracked for this game.',
};

function renderDecks(log: LogResponse): void {
  decksNote.textContent = DECK_NOTE[log.cardsSource];
  decks.replaceChildren(
    ...(log.cardsSource === 'none'
      ? []
      : log.decks.map((deck) =>
          el('li', {}, [
            el('strong', { text: deck.name }),
            el('div', { className: 'detail', text: deck.cards.length === 0 ? 'Nothing taken.' : deck.cards.map((c) => `${c.label} \u00d7 ${c.count}`).join(', ') }),
          ]),
        )),
  );
}

function render(game: GameView, log: LogResponse): void {
  const items = log.items;
  renderDecks(log);
  const winners = new Set(game.result?.winners ?? []);
  title.textContent = game.players.map((p) => p.name).join(' vs ');
  const when = new Date(game.endedAt ?? game.startedAt).toLocaleString();
  summary.textContent = `${STATUS_TEXT[game.status]}, ${game.endedAt ? 'ended' : 'started'} ${when}.`;
  if (game.status === 'active') {
    trackerAnchor.href = `/game.html?id=${encodeURIComponent(game.id)}`;
    trackerLink.hidden = false;
  }

  scores.replaceChildren(
    ...game.players.map((p) =>
      el('li', winners.has(p.seat) ? { className: 'player current' } : {}, [
        el('div', { className: 'top' }, [el('strong', { text: `${p.name}${winners.has(p.seat) ? ' (won)' : ''}` }), el('span', { className: 'cost', text: `${p.vp} VP` })]),
        el('div', { className: 'detail', text: `${p.turnsTaken} ${p.turnsTaken === 1 ? 'turn' : 'turns'}` }),
      ]),
    ),
  );
  kingdom.textContent = game.piles.filter((p) => p.kind === 'kingdom').map((p) => p.label).join(', ');

  let lastTurn = -1;
  timeline.replaceChildren(
    ...items.map((item) => {
      const heading = item.turn !== lastTurn ? `Turn ${item.turn}` : '';
      lastTurn = item.turn;
      return el('li', {}, [
        ...(heading ? [el('strong', { className: 'turn-heading', text: heading })] : []),
        el('span', { text: describe(item) }),
      ]);
    }),
  );
  noEvents.hidden = items.length > 0;
  body.hidden = false;
}

void (async () => {
  if (!(await currentUser())) {
    window.location.replace('/login.html');
    return;
  }
  const id = new URLSearchParams(window.location.search).get('id');
  if (!id) {
    message.textContent = 'No game was chosen.';
    return;
  }
  const [game, log] = await Promise.all([
    api<GameView>(`/games/${encodeURIComponent(id)}`),
    api<LogResponse>(`/games/${encodeURIComponent(id)}/log`),
  ]);
  if (game.status === 404 || log.status === 404 || game.status === 400) {
    message.textContent = 'That game could not be found.';
    return;
  }
  if (!game.ok || !game.body || !log.ok || !log.body) {
    message.textContent = 'Could not load this game. Please try again.';
    return;
  }
  render(game.body, log.body);
})();
