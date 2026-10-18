import { api, byId, currentUser } from './api.js';
import { el } from './dom.js';

interface Summary {
  id: string;
  status: 'active' | 'finished' | 'abandoned';
  playerCount: number;
  turnNumber: number;
  startedAt: string;
  players: string[];
}

const list = byId<HTMLUListElement>('games');
const empty = byId<HTMLElement>('empty');
const message = byId<HTMLElement>('message');

const STATUS: Record<Summary['status'], string> = { active: 'In progress', finished: 'Finished', abandoned: 'Abandoned' };

void (async () => {
  if (!(await currentUser())) {
    window.location.replace('/login.html');
    return;
  }
  const res = await api<{ games: Summary[] }>('/games');
  if (!res.ok || !res.body) {
    message.textContent = 'Could not load your games. Please try again.';
    return;
  }
  empty.hidden = res.body.games.length > 0;
  for (const game of res.body.games) {
    const link = el('a', { text: game.players.join(', '), attrs: { href: `/game.html?id=${encodeURIComponent(game.id)}` } });
    const top = el('div', { className: 'top' }, [el('strong', {}, [link]), el('span', { className: 'cost', text: STATUS[game.status] })]);
    const when = new Date(game.startedAt).toLocaleDateString();
    list.append(el('li', {}, [top, el('div', { className: 'detail', text: `Turn ${game.turnNumber} | started ${when}` })]));
  }
})();
