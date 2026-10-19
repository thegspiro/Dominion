export interface User {
  id: number;
  username: string;
  role: 'admin' | 'user';
}

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  body: T | null;
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export async function api<T>(path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', payload?: unknown): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (payload !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (method !== 'GET' && csrfToken) {
    headers['X-CSRF-Token'] = csrfToken;
  }
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  let body: T | null = null;
  try {
    body = (await res.json()) as T;
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}

export async function currentUser(): Promise<User | null> {
  const res = await api<{ user: User; csrfToken: string }>('/auth/me');
  if (!res.ok || !res.body) {
    return null;
  }
  setCsrfToken(res.body.csrfToken);
  return res.body.user;
}

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Incorrect username or password.',
  too_many_attempts: 'Too many attempts. Please wait a few minutes and try again.',
  invalid_setup_token: 'That setup token is not correct.',
  setup_not_configured: 'Setup is not enabled: set SETUP_TOKEN on the server and restart it.',
  invalid_invite: 'This invite link is invalid, expired, or already used.',
  username_taken: 'That username is already taken.',
  not_found: 'Setup has already been completed.',
  too_many_runs: 'You have run several simulations in the last minute. Please wait a moment and try again.',
  run_in_progress: 'A simulation is already running. Please wait for it to finish.',
  sim_unavailable: 'The simulation service is not available right now. Please try again later.',
  sim_timeout: 'The simulation took too long. Try fewer games.',
  unknown_strategy: 'That strategy is not available.',
};

export function errorMessage(res: ApiResult<{ error?: string }>): string {
  const code = res.body?.error;
  const known = code ? MESSAGES[code] : undefined;
  if (known) {
    return known;
  }
  if (res.status === 400) {
    return 'Please check your input: usernames are 3-32 letters, numbers, _ or -; passwords are 12-128 characters.';
  }
  return 'Something went wrong. Please try again.';
}

export function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing element #${id}`);
  }
  return el as T;
}
