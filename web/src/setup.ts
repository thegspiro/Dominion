import { api, byId, errorMessage, setCsrfToken, type User } from './api.js';

const form = byId<HTMLFormElement>('setup-form');
const message = byId<HTMLElement>('message');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  const data = new FormData(form);
  const res = await api<{ user: User; csrfToken: string; error?: string }>('/auth/setup', 'POST', {
    setupToken: String(data.get('setupToken') ?? ''),
    username: String(data.get('username') ?? ''),
    password: String(data.get('password') ?? ''),
  });
  if (res.ok && res.body) {
    setCsrfToken(res.body.csrfToken);
    window.location.assign('/admin.html');
    return;
  }
  message.textContent = errorMessage(res);
});

void (async () => {
  const status = await api<{ setupRequired: boolean }>('/auth/status');
  if (status.ok && status.body && !status.body.setupRequired) {
    window.location.replace('/login.html');
  }
})();
