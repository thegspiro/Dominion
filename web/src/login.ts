import { api, byId, errorMessage, type User } from './api.js';

const form = byId<HTMLFormElement>('login-form');
const message = byId<HTMLElement>('message');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  const data = new FormData(form);
  const res = await api<{ user: User; error?: string }>('/auth/login', 'POST', {
    username: String(data.get('username') ?? ''),
    password: String(data.get('password') ?? ''),
  });
  if (res.ok && res.body) {
    window.location.assign(res.body.user.role === 'admin' ? '/admin.html' : '/');
    return;
  }
  message.textContent = errorMessage(res);
});

void (async () => {
  const status = await api<{ setupRequired: boolean }>('/auth/status');
  if (status.ok && status.body?.setupRequired) {
    window.location.replace('/setup.html');
  }
})();
