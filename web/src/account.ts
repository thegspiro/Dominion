import { api, byId, currentUser, errorMessage } from './api.js';

const form = byId<HTMLFormElement>('password-form');
const done = byId<HTMLElement>('done');
const message = byId<HTMLElement>('message');

void (async () => {
  if (!(await currentUser())) {
    window.location.replace('/login.html');
  }
})();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  done.textContent = '';
  const data = new FormData(form);
  const current = String(data.get('current') ?? '');
  const password = String(data.get('password') ?? '');
  if (password !== String(data.get('repeat') ?? '')) {
    message.textContent = 'The two new passwords do not match.';
    return;
  }
  const res = await api<{ error?: string }>('/auth/password', 'POST', { currentPassword: current, newPassword: password });
  if (res.status === 401) {
    window.location.replace('/login.html');
    return;
  }
  if (!res.ok) {
    message.textContent = errorMessage(res);
    return;
  }
  form.reset();
  done.textContent = 'Your password was changed. Other devices were signed out.';
});
