import { api, byId, currentUser } from './api.js';
import { button, el } from './dom.js';

interface Pile {
  key: string;
  label: string;
  kind: string;
  count: number;
  startCount: number;
  enforced: boolean;
}

interface DeckEntry {
  key: string;
  label: string;
  count: number;
}

interface Player {
  seat: number;
  name: string;
  vp: number;
  turnsTaken: number;
  cards: DeckEntry[];
}

interface Game {
  id: string;
  version: number;
  status: 'active' | 'finished' | 'abandoned';
  turnNumber: number;
  currentSeat: number;
  resources: { actions: number; buys: number; coins: number };
  players: Player[];
  piles: Pile[];
  notes: string[];
  canUndo: boolean;
  cardsSource: 'tracked' | 'rebuilt' | 'none';
  endReasons: string[];
  result: { winners: number[]; tiedOnPoints: boolean } | null;
}

type ActionBody = Record<string, string | number>;

const root = byId<HTMLElement>('game');
const message = byId<HTMLElement>('message');
const gameId = new URLSearchParams(window.location.search).get('id') ?? '';

const status = byId<HTMLElement>('status');
const bar = byId<HTMLElement>('bar');

let game: Game | null = null;
let busy = false;
let note = '';
/** The seat that receives the next card taken, or null for whoever's turn it is. Reset after one card and when the turn ends. */
let giveSeat: number | null = null;
const openSections = new Set<string>();

const END_TEXT: Record<string, string> = {
  province_empty: 'The Province pile is empty.',
  colony_empty: 'The Colony pile is empty.',
  piles_empty: 'Three piles are empty.',
};

const ERROR_TEXT: Record<string, string> = {
  pile_empty: 'That pile does not have enough cards.',
  pile_full: 'That pile already has all its cards.',
  out_of_range: 'That value is out of range.',
  game_not_active: 'This game is over, so it cannot be changed. Use Undo to step back.',
  nothing_to_undo: 'There is nothing to undo.',
};

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
const signed = (value: number): string => (value > 0 ? `+${value}` : String(value));

function buysLeft(g: Game): string {
  return g.resources.buys === 0 ? 'No buys left. End the turn when ready.' : `${plural(g.resources.buys, 'buy')} left.`;
}

/** A short sentence about what a change did, shown under the heading so the table can see it happened. */
function describeChange(action: ActionBody, before: Game, after: Game): string {
  const actor = before.players.find((p) => p.seat === before.currentSeat)?.name ?? 'Player';
  const label = before.piles.find((p) => p.key === action['pileKey'])?.label ?? 'a card';
  const recipient = typeof action['seat'] === 'number' ? before.players.find((p) => p.seat === action['seat']) : undefined;
  const forOther = recipient !== undefined && recipient.seat !== before.currentSeat;
  switch (action['type']) {
    case 'take':
      return forOther ? `${recipient.name} gained ${label}.` : `${actor} took ${label}. ${buysLeft(after)}`;
    case 'return':
      return forOther ? `${label} was taken back from ${recipient.name}.` : `${actor} put back ${label}.`;
    case 'trash':
      return `${(recipient ?? before.players.find((p) => p.seat === before.currentSeat))?.name ?? actor} trashed ${label}.`;
    case 'set_pile':
      return `${label} was set to ${action['count']}.`;
    case 'vp': {
      const who = before.players.find((p) => p.seat === action['seat'])?.name ?? 'Player';
      return `${who}: ${signed(Number(action['delta']))} VP.`;
    }
    case 'end_turn':
      return after.status === 'active' ? `${after.players.find((p) => p.seat === after.currentSeat)?.name ?? 'Next player'}'s turn.` : '';
    case 'undo':
      return 'Last change undone.';
    default:
      return '';
  }
}

/** The extra `seat` field for a take or return: only when the chip points at someone other than the current player. */
function recipientField(g: Game): { seat?: number } {
  return giveSeat !== null && giveSeat !== g.currentSeat ? { seat: giveSeat } : {};
}

async function send(action: ActionBody): Promise<void> {
  if (busy || !game) {
    return;
  }
  const before = game;
  busy = true;
  document.body.classList.add('busy');
  message.textContent = '';
  const res = await api<Game & { error?: string; reason?: string; game?: Game }>(
    `/games/${encodeURIComponent(gameId)}/actions`,
    'POST',
    { expectedVersion: before.version, action },
  );
  busy = false;
  document.body.classList.remove('busy');
  if (res.ok && res.body) {
    game = res.body;
    note = describeChange(action, before, game);
    if (action['type'] === 'take' || action['type'] === 'return' || action['type'] === 'end_turn' || action['type'] === 'undo') {
      giveSeat = null;
    }
  } else if (res.status === 409 && res.body?.game) {
    game = res.body.game;
    note = '';
    message.textContent = 'The game had changed, so it was refreshed. Please try again.';
  } else if (res.status === 401) {
    window.location.replace('/login.html');
    return;
  } else {
    const reason = res.body?.reason ?? '';
    message.textContent = ERROR_TEXT[reason] ?? 'That change was not accepted.';
  }
  render();
}

function stepper(label: string, value: number, resource: string): HTMLElement {
  return el('div', { className: 'stepper' }, [
    el('div', { className: 'label', text: label }),
    el('div', { className: 'value', text: String(value) }),
    el('div', { className: 'buttons' }, [
      button('-', () => void send({ type: 'resource', resource, delta: -1 }), { aria: `Remove one ${label.toLowerCase()}` }),
      button('+', () => void send({ type: 'resource', resource, delta: 1 }), { aria: `Add one ${label.toLowerCase()}` }),
    ]),
  ]);
}

/** A section that stays open or closed across re-renders, because every change rebuilds the page. */
function section(id: string, summary: string, children: Node[]): HTMLElement {
  const details = el('details', {}, [el('summary', { text: summary }), ...children]);
  details.open = openSections.has(id);
  details.addEventListener('toggle', () => {
    if (details.open) {
      openSections.add(id);
    } else {
      openSections.delete(id);
    }
  });
  return details;
}

function supplyTile(pile: Pile): HTMLElement {
  const left = pile.count === 0 ? 'empty' : `${pile.count} left${pile.enforced ? '' : ' (by hand)'}`;
  const take = el('button', {
    className: 'supply-tile',
    attrs: { type: 'button', 'aria-label': pile.count === 0 ? `${pile.label}, empty` : `Take one ${pile.label}, ${pile.count} left` },
  }, [el('span', { className: 'name', text: pile.label.replace(/\//g, '/\u200b') }), el('span', { className: 'left', text: left })]);
  take.disabled = pile.count === 0;
  take.addEventListener('click', () => void send({ type: 'take', pileKey: pile.key, ...recipientField(game as Game) }));
  const back = button('−', () => void send({ type: 'return', pileKey: pile.key }), {
    aria: `Return one ${pile.label}`,
    className: 'supply-return',
    disabled: pile.enforced && pile.count >= pile.startCount,
  });
  return el('li', { className: 'supply-item' }, [take, back]);
}

function supplyGrid(piles: Pile[]): HTMLElement {
  return el('ul', { className: 'supply-grid' }, piles.map(supplyTile));
}

function readOnlyPile(pile: Pile): HTMLElement {
  const count = pile.enforced ? `${pile.count} of ${pile.startCount}` : `${pile.count} (counted by hand)`;
  return el('li', { className: pile.count === 0 ? 'pile empty' : 'pile' }, [
    el('div', { className: 'top' }, [el('strong', { text: pile.label }), el('span', { className: 'cost', text: pile.count === 0 ? 'empty' : count })]),
  ]);
}

function handCountedPile(pile: Pile): HTMLElement {
  const input = el('input', {
    attrs: { type: 'number', min: '0', max: '999', value: String(pile.count), 'aria-label': `Cards left in ${pile.label}` },
  });
  input.addEventListener('change', () => {
    const value = Number(input.value);
    if (Number.isInteger(value) && value >= 0 && value <= 999) {
      void send({ type: 'set_pile', pileKey: pile.key, count: value });
    }
  });
  return el('div', { className: 'player' }, [el('strong', { text: pile.label }), el('div', { className: 'controls' }, [input])]);
}

function scoreCard(player: Player, current: boolean): HTMLElement {
  return el('div', { className: current ? 'score-card current' : 'score-card' }, [
    el('div', { className: 'who', text: player.name }),
    el('div', { className: 'vp', text: `${player.vp} VP` }),
  ]);
}

function scoreControls(player: Player): HTMLElement {
  const buttons = [-1, 1, 3, 6].map((delta) =>
    button(signed(delta), () => void send({ type: 'vp', seat: player.seat, delta }), {
      aria: `${delta > 0 ? 'Add' : 'Remove'} ${plural(Math.abs(delta), 'victory point')} for ${player.name}`,
    }),
  );
  return el('div', { className: 'player' }, [el('strong', { text: player.name }), el('div', { className: 'controls' }, buttons)]);
}

function givingChip(g: Game): HTMLElement {
  const target = giveSeat === null ? g.currentSeat : giveSeat;
  const who = g.players.find((p) => p.seat === target)?.name ?? 'Player';
  const other = target !== g.currentSeat;
  const chip = button(`Gaining for: ${who}${other ? ' (not the current player)' : ''}`, () => {
    const seats = g.players.map((p) => p.seat);
    const next = seats[(seats.indexOf(target) + 1) % seats.length] ?? g.currentSeat;
    giveSeat = next === g.currentSeat ? null : next;
    render();
  }, { className: other ? 'give-chip other' : 'give-chip', aria: `Cards go to ${who}. Tap to choose another player.` });
  return el('p', {}, [chip]);
}

function deckBlock(player: Player, active: boolean): HTMLElement {
  const rows =
    player.cards.length === 0
      ? [el('p', { className: 'detail', text: 'Nothing taken yet.' })]
      : player.cards.map((card) =>
          el('div', { className: 'deck-row' }, [
            el('span', { text: `${card.label} \u00d7 ${card.count}` }),
            ...(active
              ? [button('Trash', () => void send({ type: 'trash', pileKey: card.key, seat: player.seat }), { aria: `Trash one ${card.label} from ${player.name}'s deck` })]
              : []),
          ]),
        );
  return el('div', { className: 'player' }, [el('strong', { text: player.name }), ...rows]);
}

function decksSection(g: Game, active: boolean): HTMLElement {
  const notes: Node[] = [];
  if (g.cardsSource === 'none') {
    notes.push(el('p', { className: 'detail', text: 'Cards taken before decks were tracked are not listed for this game.' }));
  } else if (g.cardsSource === 'rebuilt') {
    notes.push(el('p', { className: 'detail', text: 'Rebuilt from the game log: cards given to an opponent before decks were tracked are listed under the player whose turn it was.' }));
  }
  notes.push(el('p', { className: 'detail', text: 'Cards taken from the supply only. Starting cards are not counted.' }));
  return section('decks', 'Decks', [...notes, ...g.players.map((p) => deckBlock(p, active))]);
}

function setStatus(g: Game): void {
  const text = note !== '' ? note : g.status === 'active' && g.resources.buys === 0 ? buysLeft(g) : '';
  status.textContent = text;
}

function renderBar(g: Game, current: Player | undefined): void {
  const undo = button('Undo', () => void send({ type: 'undo' }), { className: 'undo', disabled: !g.canUndo });
  if (g.status === 'active') {
    const name = current?.name ?? 'Player';
    bar.replaceChildren(
      el('div', { className: 'bottom-bar-inner' }, [undo, button(g.endReasons.length > 0 ? 'End turn and finish the game' : `End ${name}'s turn`, () => void send({ type: 'end_turn' }), { className: 'primary' })]),
    );
  } else {
    bar.replaceChildren(el('div', { className: 'bottom-bar-inner' }, [undo]));
  }
  bar.hidden = false;
  document.body.classList.add('has-bar');
}

function render(): void {
  if (!game) {
    return;
  }
  const g = game;
  const scrollY = window.scrollY;
  const active = g.status === 'active';
  const current = g.players.find((p) => p.seat === g.currentSeat);
  document.title = `Dominion Helper - ${g.players.map((p) => p.name).join(', ')}`;
  setStatus(g);

  const children: Node[] = [el('p', {}, [el('a', { text: 'Games', attrs: { href: '/games.html' } })])];

  if (active) {
    children.push(el('h1', { text: `${current?.name ?? 'Player'}'s turn` }), el('p', { className: 'detail', text: `Turn ${g.turnNumber}` }));
    if (g.endReasons.length > 0) {
      children.push(
        el('p', {
          className: 'status banner',
          text: `${g.endReasons.map((r) => END_TEXT[r] ?? r).join(' ')} The game ends when this turn ends.`,
          attrs: { role: 'status', 'data-state': 'fail' },
        }),
      );
    }
    children.push(
      status,
      message,
      section('counters', `Actions ${g.resources.actions} · Buys ${g.resources.buys} · Coins ${g.resources.coins}`, [
        el('div', { className: 'steppers' }, [
          stepper('Actions', g.resources.actions, 'actions'),
          stepper('Buys', g.resources.buys, 'buys'),
          stepper('Coins', g.resources.coins, 'coins'),
        ]),
      ]),
    );
  } else {
    const winners = g.result ? g.players.filter((p) => g.result?.winners.includes(p.seat)).map((p) => p.name) : [];
    children.push(el('h1', { text: g.status === 'finished' ? 'Game over' : 'Game abandoned' }), status, message);
    if (g.status === 'finished') {
      const tie = g.result?.tiedOnPoints ? ' (tie on points, decided by turns taken)' : '';
      children.push(
        el('p', {
          className: 'status banner',
          text: `${winners.length > 1 ? 'Shared win' : 'Winner'}: ${winners.join(' and ')}${tie}`,
          attrs: { role: 'status', 'data-state': 'ok' },
        }),
      );
    }
  }

  if (active) {
    const kingdom = g.piles.filter((p) => p.kind === 'kingdom');
    const basic = g.piles.filter((p) => p.kind !== 'kingdom');
    const empty = g.piles.filter((p) => p.count === 0).length;
    children.push(givingChip(g));
    if (kingdom.length > 0) {
      children.push(el('h2', { className: 'section-title', text: 'Kingdom' }), supplyGrid(kingdom));
    }
    children.push(el('h2', { className: kingdom.length > 0 ? 'sub-title' : 'section-title', text: 'Basic supply' }), supplyGrid(basic));
    children.push(el('p', { className: 'detail', text: `Empty piles: ${empty}` }));
  } else {
    children.push(section('supply', 'Final supply', [el('ul', { className: 'cards piles' }, g.piles.map(readOnlyPile))]));
  }

  children.push(el('h2', { className: 'section-title', text: 'Scores' }), el('div', { className: 'score-row' }, g.players.map((p) => scoreCard(p, active && p.seat === g.currentSeat))));

  children.push(decksSection(g, active));

  if (active) {
    children.push(section('scores', 'Change scores', g.players.map(scoreControls)));
    const manual = g.piles.filter((p) => !p.enforced);
    const more: Node[] = [];
    if (manual.length > 0) {
      more.push(el('p', { className: 'detail', text: 'These piles are counted by hand. Set how many cards are left.' }), ...manual.map(handCountedPile));
    }
    if (g.notes.length > 0) {
      more.push(el('h3', { text: 'Not enforced' }), el('ul', {}, g.notes.map((n) => el('li', { text: n }))));
    }
    more.push(
      el('div', { className: 'turn-actions' }, [
        button('Finish game', () => {
          if (window.confirm('Finish the game now and show the result?')) {
            void send({ type: 'finish' });
          }
        }),
        button('Abandon game', () => {
          if (window.confirm('Abandon this game? It will not count as finished.')) {
            void send({ type: 'abandon' });
          }
        }),
      ]),
    );
    children.push(section('more', 'More', more));
  } else if (g.notes.length > 0) {
    children.push(section('notes', 'Not enforced', [el('ul', {}, g.notes.map((n) => el('li', { text: n })))]));
  }

  root.replaceChildren(...children);
  renderBar(g, current);
  window.scrollTo(0, scrollY);
}

void (async () => {
  if (!(await currentUser())) {
    window.location.replace('/login.html');
    return;
  }
  const res = await api<Game>(`/games/${encodeURIComponent(gameId)}`);
  if (res.status === 404 || res.status === 400) {
    byId<HTMLElement>('loading').textContent = 'That game was not found.';
    return;
  }
  if (!res.ok || !res.body) {
    byId<HTMLElement>('loading').textContent = 'Could not load the game. Please try again.';
    return;
  }
  game = res.body;
  render();
})();
