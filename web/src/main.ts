import { currentUser } from './api.js';

interface ReadyResponse {
  status: string;
  checks?: Record<string, string>;
}

async function showStatus(target: HTMLElement): Promise<void> {
  try {
    const res = await fetch('/api/health/ready', { headers: { Accept: 'application/json' } });
    const body = (await res.json()) as ReadyResponse;
    const parts = Object.entries(body.checks ?? {}).map(([name, value]) => `${name}: ${value}`);
    target.textContent = `${res.ok ? 'All systems ready' : 'Service degraded'}${parts.length ? ` (${parts.join(', ')})` : ''}`;
    target.dataset['state'] = res.ok ? 'ok' : 'fail';
  } catch {
    target.textContent = 'API unreachable';
    target.dataset['state'] = 'fail';
  }
}

const statusEl = document.getElementById('status');
if (statusEl) {
  void showStatus(statusEl);
}

const accountEl = document.getElementById('account');
if (accountEl) {
  void (async () => {
    const user = await currentUser();
    if (user) {
      accountEl.textContent = `Signed in as ${user.username}`;
      if (user.role === 'admin') {
        const link = document.createElement('a');
        link.href = '/admin.html';
        link.textContent = ' (admin)';
        accountEl.append(link);
      }
    } else {
      const link = document.createElement('a');
      link.href = '/login.html';
      link.textContent = 'Log in';
      accountEl.append(link);
    }
  })();
}
