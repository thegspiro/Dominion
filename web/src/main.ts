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
