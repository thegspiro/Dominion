import { api, byId, currentUser } from './api.js';

const who = byId<HTMLElement>('who');
const createButton = byId<HTMLButtonElement>('create-invite');
const logoutButton = byId<HTMLButtonElement>('logout');
const result = byId<HTMLElement>('invite-result');
const link = byId<HTMLInputElement>('invite-link');
const message = byId<HTMLElement>('message');

void (async () => {
  const user = await currentUser();
  if (!user) {
    window.location.replace('/login.html');
    return;
  }
  if (user.role !== 'admin') {
    window.location.replace('/');
    return;
  }
  who.textContent = `Signed in as ${user.username}`;
  createButton.disabled = false;
})();

createButton.addEventListener('click', async () => {
  message.textContent = '';
  result.hidden = true;
  const res = await api<{ token: string; expiresInHours: number }>('/auth/invites', 'POST');
  if (!res.ok || !res.body) {
    message.textContent = 'Could not create an invite. Please try again.';
    return;
  }
  link.value = `${window.location.origin}/invite.html#${res.body.token}`;
  byId<HTMLElement>('invite-expiry').textContent = `Single use. Expires in ${res.body.expiresInHours} hours.`;
  result.hidden = false;
  link.select();
});

logoutButton.addEventListener('click', async () => {
  await api('/auth/logout', 'POST');
  window.location.assign('/login.html');
});
