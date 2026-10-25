import { api, byId, errorMessage } from './api.js';

const form = byId<HTMLFormElement>('reset-form');
const message = byId<HTMLElement>('message');
const token = window.location.hash.slice(1);

if (token === '') {
  message.textContent = 'This reset link is missing its token. Ask the administrator for a new link.';
  form.hidden = true;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  const data = new FormData(form);
  const password = String(data.get('password') ?? '');
  if (password !== String(data.get('repeat') ?? '')) {
    message.textContent = 'The two passwords do not match.';
    return;
  }
  const res = await api<{ error?: string }>('/auth/password-reset/redeem', 'POST', { token, password });
  if (res.ok) {
    window.history.replaceState(null, '', window.location.pathname);
    window.location.assign('/login.html?reset=1');
    return;
  }
  message.textContent = errorMessage(res);
});
