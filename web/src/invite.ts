import { api, byId, errorMessage, type User } from './api.js';

const form = byId<HTMLFormElement>('invite-form');
const message = byId<HTMLElement>('message');
const token = window.location.hash.slice(1);

if (token === '') {
  message.textContent = 'This invite link is missing its token. Ask for a new link.';
  form.hidden = true;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  const data = new FormData(form);
  const res = await api<{ user: User; error?: string }>('/auth/invites/redeem', 'POST', {
    token,
    username: String(data.get('username') ?? ''),
    password: String(data.get('password') ?? ''),
  });
  if (res.ok) {
    window.history.replaceState(null, '', window.location.pathname);
    window.location.assign('/');
    return;
  }
  message.textContent = errorMessage(res);
});
