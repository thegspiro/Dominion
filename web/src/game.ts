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

interface Player {
  seat: number;
  name: string;
  vp: number;
  turnsTaken: number;
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
  endReasons: string[];
  result: { winners: number[]; tiedOnPoints: boolean } | null;
}

type ActionBody = Record<string, string | number>;

const root = byId<HTMLElement>('game');
const message = byId<HTMLElement>('message');
const gameId = new URLSearchParams(window.location.search).get('id') ?? '';

let game: Game | null = null;
let busy = false;

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

async function send(action: ActionBody): Promise<void> {
  if (busy || !game) {
    return;
  }
  busy = true;
  message.textContent = '';
  const res = await api<Game & { error?: string; reason?: string; game?: Game }>(
    `/games/${encodeURIComponent(gameId)}/actions`,
    'POST',
    { expectedVersion: game.version, action },
  );
  busy = false;
  if (res.ok && res.body) {
    game = res.body;
  } else if (res.status === 409 && res.body?.game) {
    game = res.body.game;
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

function pileRow(pile: Pile, active: boolean): HTMLElement {
  const count = pile.enforced ? `${pile.count} of ${pile.startCount}` : `${pile.count} (counted by hand)`;
  const controls: Node[] = [
    button('Take', () => void send({ type: 'take', pileKey: pile.key }), { aria: `Take one ${pile.label}`, disabled: pile.count === 0 }),
    button('Return', () => void send({ type: 'return', pileKey: pile.key }), {
      aria: `Return one ${pile.label}`,
      disabled: pile.enforced && pile.count >= pile.startCount,
    }),
  ];
  if (!active) {
    return el('li', { className: pile.count === 0 ? 'pile empty' : 'pile' }, [
      el('div', { className: 'top' }, [el('strong', { text: pile.label }), el('span', { className: 'cost', text: pile.count === 0 ? 'empty' : count })]),
    ]);
  }
  if (!pile.enforced) {
    const input = el('input', {
      attrs: { type: 'number', min: '0', max: '999', value: String(pile.count), 'aria-label': `Cards left in ${pile.label}` },
    });
    input.addEventListener('change', () => {
      const value = Number(input.value);
      if (Number.isInteger(value) && value >= 0 && value <= 999) {
        void send({ type: 'set_pile', pileKey: pile.key, count: value });
      }
    });
    controls.push(input);
  }
  return el('li', { className: pile.count === 0 ? 'pile empty' : 'pile' }, [
    el('div', { className: 'top' }, [el('strong', { text: pile.label }), el('span', { className: 'cost', text: pile.count === 0 ? 'empty' : count })]),
    el('div', { className: 'controls' }, controls),
  ]);
}

function playerRow(player: Player, current: boolean, active: boolean): HTMLElement {
  const buttons = [-1, 1, 3, 6].map((delta) =>
    button(delta > 0 ? `+${delta}` : String(delta), () => void send({ type: 'vp', seat: player.seat, delta }), {
      aria: `${delta > 0 ? 'Add' : 'Remove'} ${Math.abs(delta)} victory point${Math.abs(delta) === 1 ? '' : 's'} for ${player.name}`,
    }),
  );
  const header = el('div', { className: 'top' }, [
    el('strong', { text: `${player.name}${current && active ? ' (playing)' : ''}` }),
    el('span', { className: 'cost', text: `${player.vp} VP` }),
  ]);
  return el('li', { className: current && active ? 'player current' : 'player' }, active ? [header, el('div', { className: 'controls' }, buttons)] : [header]);
}

function render(): void {
  if (!game) {
    return;
  }
  const g = game;
  const active = g.status === 'active';
  const current = g.players.find((p) => p.seat === g.currentSeat);
  document.title = `Dominion Helper - ${g.players.map((p) => p.name).join(', ')}`;

  const children: Node[] = [el('p', {}, [el('a', { text: 'Games', attrs: { href: '/games.html' } })])];

  if (active) {
    children.push(
      el('h1', { text: `${current?.name ?? 'Player'}'s turn` }),
      el('p', { className: 'detail', text: `Turn ${g.turnNumber} | ${g.players.length} players` }),
    );
    if (g.endReasons.length > 0) {
      children.push(
        el('p', {
          className: 'status',
          text: `${g.endReasons.map((r) => END_TEXT[r] ?? r).join(' ')} The game ends when this turn ends.`,
          attrs: { role: 'status', 'data-state': 'fail' },
        }),
      );
    }
    children.push(
      el('div', { className: 'steppers' }, [
        stepper('Actions', g.resources.actions, 'actions'),
        stepper('Buys', g.resources.buys, 'buys'),
        stepper('Coins', g.resources.coins, 'coins'),
      ]),
    );
  } else {
    const winners = g.result ? g.players.filter((p) => g.result?.winners.includes(p.seat)).map((p) => p.name) : [];
    children.push(el('h1', { text: g.status === 'finished' ? 'Game over' : 'Game abandoned' }));
    if (g.status === 'finished') {
      const tie = g.result?.tiedOnPoints ? ' (tie on points, decided by turns taken)' : '';
      children.push(
        el('p', {
          className: 'status',
          text: `${winners.length > 1 ? 'Shared win' : 'Winner'}: ${winners.join(' and ')}${tie}`,
          attrs: { role: 'status', 'data-state': 'ok' },
        }),
      );
    }
  }

  children.push(el('h2', { text: 'Scores' }), el('ul', { className: 'cards' }, g.players.map((p) => playerRow(p, p.seat === g.currentSeat, active))));

  if (active) {
    children.push(
      el('div', { className: 'turn-actions' }, [
        button('End turn', () => void send({ type: 'end_turn' }), { className: 'primary' }),
        button('Undo', () => void send({ type: 'undo' }), { disabled: !g.canUndo }),
      ]),
    );
  } else {
    children.push(el('div', { className: 'turn-actions' }, [button('Undo', () => void send({ type: 'undo' }), { disabled: !g.canUndo })]));
  }

  const empty = g.piles.filter((p) => p.count === 0).length;
  children.push(el('h2', { text: 'Supply' }), el('p', { className: 'detail', text: `Empty piles: ${empty}` }));
  children.push(el('ul', { className: 'cards piles' }, g.piles.map((p) => pileRow(p, active))));

  if (g.notes.length > 0) {
    children.push(el('h2', { text: 'Not enforced' }), el('ul', {}, g.notes.map((n) => el('li', { text: n }))));
  }

  if (active) {
    children.push(
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
  }

  children.push(message);
  root.replaceChildren(...children);
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
