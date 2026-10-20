import { api, byId, currentUser, errorMessage } from './api.js';
import { el } from './dom.js';

interface StrategyInfo {
  id: string;
  name: string;
  description: string;
}

interface OddsRow {
  ways: number;
  of: number;
  percent: number;
}

interface Odds {
  hands: (OddsRow & { coins: number })[];
  splits: (OddsRow & { label: string })[];
}

interface Side {
  strategy: string;
  wins: number;
  win_rate: number;
  games_reaching_four_provinces: number;
  average_turn_to_four_provinces: number | null;
}

interface SimulationResult {
  games: number;
  seed: number;
  a: Side;
  b: Side;
  ties: number;
  tie_rate: number;
  average_turns_per_player: number | null;
}

const MAX_GAMES = 5000;
const MAX_SEED = 4_294_967_295;

const oddsBox = byId<HTMLElement>('odds');
const splitsBox = byId<HTMLElement>('splits');
const form = byId<HTMLFormElement>('simulate');
const selectA = byId<HTMLSelectElement>('strategy-a');
const selectB = byId<HTMLSelectElement>('strategy-b');
const descriptionA = byId<HTMLElement>('description-a');
const descriptionB = byId<HTMLElement>('description-b');
const gamesInput = byId<HTMLInputElement>('games');
const seedInput = byId<HTMLInputElement>('seed');
const runButton = byId<HTMLButtonElement>('run');
const message = byId<HTMLElement>('message');
const results = byId<HTMLElement>('results');

let strategies: StrategyInfo[] = [];

const percent = (value: number): string => `${value.toFixed(1)}%`;
const ratePercent = (rate: number): string => percent(rate * 100);

function showError(text: string): void {
  message.textContent = text;
}

function oddsRow(label: string, row: OddsRow): HTMLElement {
  const bar = el('progress', { attrs: { max: String(row.of), value: String(row.ways), 'aria-label': `${label}: ${percent(row.percent)}` } });
  return el('div', { className: 'odds-row' }, [
    el('span', { className: 'odds-label', text: label }),
    bar,
    el('span', { className: 'odds-value', text: `${percent(row.percent)} (${row.ways}/${row.of})` }),
  ]);
}

function showOdds(odds: Odds): void {
  oddsBox.replaceChildren(...odds.hands.map((hand) => oddsRow(`$${hand.coins} hand`, hand)));
  const [better, worse] = odds.splits;
  if (better && worse) {
    splitsBox.replaceChildren(
      el('p', { text: `${percent(better.percent)} of the time your two opening hands split $${better.label.replace('/', ' and $')}.` }),
      el('p', { text: `${percent(worse.percent)} of the time they split $${worse.label.replace('/', ' and $')}.` }),
    );
  }
}

function describe(select: HTMLSelectElement, target: HTMLElement): void {
  target.textContent = strategies.find((s) => s.id === select.value)?.description ?? '';
}

function nameOf(id: string): string {
  return strategies.find((s) => s.id === id)?.name ?? id;
}

function sideCard(side: Side, games: number): HTMLElement {
  const reached = side.average_turn_to_four_provinces;
  const reachedText =
    reached === null
      ? 'Never reached 4 Provinces'
      : `Reaches 4 Provinces on turn ${reached.toFixed(1)} on average (${side.games_reaching_four_provinces} of ${games} games)`;
  return el('li', {}, [
    el('div', { className: 'top' }, [el('strong', { text: nameOf(side.strategy) }), el('span', { className: 'cost', text: ratePercent(side.win_rate) })]),
    el('progress', { attrs: { max: '1', value: String(side.win_rate), 'aria-label': `${nameOf(side.strategy)} win rate` } }),
    el('div', { className: 'detail', text: `${side.wins} wins. ${reachedText}.` }),
  ]);
}

function showResult(result: SimulationResult): void {
  const turns = result.average_turns_per_player;
  results.replaceChildren(
    el('h2', { text: 'Results' }),
    el('ul', { className: 'cards' }, [sideCard(result.a, result.games), sideCard(result.b, result.games)]),
    el('p', { text: `Ties: ${result.ties} (${ratePercent(result.tie_rate)}). ${turns === null ? '' : `Games lasted ${turns.toFixed(1)} turns per player on average.`}` }),
    el('p', {
      className: 'hint',
      text: `${result.games} games, seed ${result.seed}. Enter this seed to repeat the run. The first player alternates from game to game.`,
    }),
  );
  results.hidden = false;
}

function readInteger(input: HTMLInputElement, min: number, max: number): number | null {
  const raw = input.value.trim();
  if (!/^\d{1,10}$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  return value >= min && value <= max ? value : null;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  message.textContent = '';
  const games = readInteger(gamesInput, 1, MAX_GAMES);
  if (games === null) {
    showError(`Enter a number of games between 1 and ${MAX_GAMES}.`);
    return;
  }
  const payload: { a: string; b: string; games: number; seed?: number } = { a: selectA.value, b: selectB.value, games };
  if (seedInput.value.trim() !== '') {
    const seed = readInteger(seedInput, 0, MAX_SEED);
    if (seed === null) {
      showError(`Enter a seed between 0 and ${MAX_SEED}, or leave it empty.`);
      return;
    }
    payload.seed = seed;
  }
  runButton.disabled = true;
  runButton.textContent = 'Running…';
  void (async () => {
    try {
      const res = await api<SimulationResult & { error?: string }>('/strategy/simulate', 'POST', payload);
      if (!res.ok || !res.body) {
        showError(errorMessage(res));
        return;
      }
      showResult(res.body);
    } catch {
      showError('Could not reach the server. Please try again.');
    } finally {
      runButton.disabled = false;
      runButton.textContent = 'Run simulation';
    }
  })();
});

selectA.addEventListener('change', () => describe(selectA, descriptionA));
selectB.addEventListener('change', () => describe(selectB, descriptionB));

void (async () => {
  if (!(await currentUser())) {
    window.location.replace('/login.html');
    return;
  }
  const [oddsRes, strategyRes] = await Promise.all([
    api<Odds>('/strategy/odds'),
    api<{ strategies: StrategyInfo[] }>('/strategy/strategies'),
  ]);
  if (oddsRes.ok && oddsRes.body) {
    showOdds(oddsRes.body);
  }
  if (!strategyRes.ok || !strategyRes.body) {
    showError('The simulation service is not available right now. Please try again later.');
    return;
  }
  strategies = strategyRes.body.strategies;
  for (const strategy of strategies) {
    selectA.append(el('option', { text: strategy.name, attrs: { value: strategy.id } }));
    selectB.append(el('option', { text: strategy.name, attrs: { value: strategy.id } }));
  }
  if (strategies[1]) {
    selectB.value = strategies[1].id;
  }
  describe(selectA, descriptionA);
  describe(selectB, descriptionB);
  runButton.disabled = strategies.length === 0;
})();
