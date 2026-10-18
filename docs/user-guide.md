# User guide: accounts and sign-in

Dominion Helper is invite-only. The first person to run the app creates the administrator account with a setup token; everyone else joins through an invite link from the administrator.

Screenshots were captured from a local stack in Chromium at 900 px (desktop) and 390 px (phone) widths. They may drift as the interface changes.

## Home page

When you are signed out, the home page shows a **Log in** link and a status line confirming the database and simulation service are reachable.

![Home page, signed out](images/01-home-signed-out.png)

Once signed in, the page shows who you are (admins also get an **(admin)** link).

![Home page, signed in on a phone](images/07-home-signed-in-phone.png)

## First-run setup (administrator)

1. Set `SETUP_TOKEN` in `.env` to a secret of at least 16 characters (for example `openssl rand -base64 24`) and start the stack.
2. Open `/setup.html`. While no account exists, `/login.html` redirects here.
3. Enter the setup token, then choose a username (3-32 letters, numbers, `_` or `-`) and a password (12-128 characters).

![First-run setup form](images/02-setup-first-run.png)

A wrong setup token is refused and no account is created.

![Setup with a wrong token](images/03-setup-wrong-token.png)

Setup works only once: as soon as any account exists, the setup endpoint stops responding.

## Inviting a friend (administrator)

After setup you land on the administration page (`/admin.html`).

![Administration page](images/04-admin.png)

Choose **Create invite link** and send the link to your friend. Each link works once and expires after 72 hours. The token sits after the `#` in the address, so it is not sent to the server when the page loads.

![Administration page with an invite link](images/05-admin-invite-link.png)

## Accepting an invite

Your friend opens the link, picks a username and password, and is signed in straight away.

![Invite page on a phone](images/06-invite-phone.png)

If the link was already used, has expired, or is incomplete, the page says so and no account is created.

![Reused invite link](images/08-invite-reused-phone.png)

## Logging in

Use `/login.html` on later visits.

![Log in](images/09-login.png)

A wrong username or a wrong password gives the same message, so the page does not reveal which usernames exist.

![Login error](images/10-login-error.png)

## Good to know

- Sessions last 30 days and renew while you keep using the app. **Log out** on the administration page ends the session on that device.
- After 8 failed attempts a username is locked for 15 minutes.
- Session cookies are marked `Secure` by default, which needs HTTPS (or `http://localhost`). If you serve plain HTTP on a LAN address, set `COOKIE_SECURE=false` in `.env`.
- There is no password reset yet. A forgotten password currently needs a new invite.
