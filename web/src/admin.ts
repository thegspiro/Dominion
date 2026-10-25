import { api, byId, currentUser } from './api.js';
import { button, el } from './dom.js';

const who = byId<HTMLElement>('who');
const createButton = byId<HTMLButtonElement>('create-invite');
const logoutButton = byId<HTMLButtonElement>('logout');
const result = byId<HTMLElement>('invite-result');
const link = byId<HTMLInputElement>('invite-link');
const message = byId<HTMLElement>('message');
const users = byId<HTMLUListElement>('users');
const resetResult = byId<HTMLElement>('reset-result');
const resetLink = byId<HTMLInputElement>('reset-link');

interface Account {
  id: number;
  username: string;
  role: 'admin' | 'user';
  lastLoginAt: string | null;
}

async function makeResetLink(account: Account): Promise<void> {
  message.textContent = '';
  resetResult.hidden = true;
  const res = await api<{ token: string; expiresInHours: number; username: string }>(`/auth/users/${account.id}/password-reset`, 'POST');
  if (!res.ok || !res.body) {
    message.textContent = 'Could not create a reset link. Please try again.';
    return;
  }
  byId<HTMLElement>('reset-label').textContent = `Send this link to ${res.body.username}`;
  resetLink.value = `${window.location.origin}/reset.html#${res.body.token}`;
  byId<HTMLElement>('reset-expiry').textContent = `Single use. Expires in ${res.body.expiresInHours} hours. Anyone who has this link can set a new password for ${res.body.username}, so send it privately. Any older link for this account no longer works.`;
  resetResult.hidden = false;
  resetLink.select();
}

async function loadAccounts(): Promise<void> {
  const res = await api<{ users: Account[] }>('/auth/users');
  if (!res.ok || !res.body) {
    message.textContent = 'Could not load the accounts. Please try again.';
    return;
  }
  users.replaceChildren(
    ...res.body.users.map((account) => {
      const seen = account.lastLoginAt ? `Last signed in ${new Date(account.lastLoginAt).toLocaleDateString()}` : 'Never signed in';
      return el('li', {}, [
        el('div', { className: 'top' }, [el('strong', { text: account.username }), el('span', { className: 'cost', text: account.role })]),
        el('div', { className: 'detail', text: seen }),
        button('Reset password', () => void makeResetLink(account), { aria: `Make a password reset link for ${account.username}` }),
      ]);
    }),
  );
}

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
  await loadAccounts();
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
