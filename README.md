# Dominion Helper

A web app for the card game Dominion: kingdom setup, a shared-table game tracker, game history and stats, and strategy tools.

## Layout

| Path | Purpose |
| --- | --- |
| `api/` | TypeScript (Fastify) REST API and migration runner |
| `sim/` | Python (FastAPI) simulation service |
| `web/` | Static HTML + vanilla TypeScript frontend, served by nginx |
| `db/migrations/` | MySQL migrations (see its README) |

## Run with Docker

    cp .env.example .env     # then set real passwords
    docker compose up --build

Open http://localhost:8080. MySQL is not published; the `migrate` service applies pending migrations before the API starts.

## Accounts

Access is invite-only. Set `SETUP_TOKEN` in `.env` (16+ characters), start the stack, and open `/setup.html` to create the administrator; the setup page stops working as soon as any user exists. The admin page (`/admin.html`) creates single-use invite links (valid 72 hours) for other people.

- Passwords are hashed with argon2id; sessions are stored server-side and last 30 days (sliding). The browser holds only a random token in an httpOnly, SameSite=Lax cookie.
- `COOKIE_SECURE` defaults to `true`. If you serve plain HTTP on a LAN address, set it to `false`; prefer HTTPS via a reverse proxy.
- Login attempts are rate limited in memory per IP and per username (the limits reset when the API restarts). After 8 failures a username is locked for 15 minutes, so someone who knows a username can temporarily block that login.
- The API sits behind the web container's proxy, so `TRUST_PROXY=true` is set in compose to read the client IP from `X-Forwarded-For`. The API port is also published; do not expose it beyond your trusted network, because a direct caller could spoof that header and sidestep the per-IP limit.
- Rollback: `npm --prefix api run migrate -- down` drops the `users`, `sessions` and `invites` tables, which deletes all accounts.

## Tests

    npm --prefix api ci && npm --prefix api test
    TEST_DB_HOST=127.0.0.1 TEST_DB_USER=... TEST_DB_PASSWORD=... TEST_DB_NAME=... npm --prefix api test   # includes MySQL migration tests
    python -m venv .venv && .venv/bin/pip install -r sim/requirements-dev.txt && (cd sim && ../.venv/bin/python -m pytest)
    npm --prefix web ci && npm --prefix web run typecheck

The MySQL-backed tests drop and recreate `schema_migrations`, `users`, `sessions`, `invites`, `widget` and `gadget`; point them at a throwaway database.
