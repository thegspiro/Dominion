# Dominion Helper

A web app for the card game Dominion: kingdom setup, a shared-table game tracker, game history and stats, and strategy tools.

## Layout

| Path | Purpose |
| --- | --- |
| `api/` | TypeScript (Fastify) REST API and migration runner |
| `sim/` | Python (FastAPI) simulation service |
| `web/` | Static HTML + vanilla TypeScript frontend, served by nginx |
| `db/migrations/` | MySQL migrations (see its README) |
| `db/data/` | Card data snapshot, corrections and licence notice |

## Run with Docker

    cp .env.example .env     # then set real passwords
    docker compose up --build

Open http://localhost:8080. MySQL is not published; the `migrate` service applies pending migrations before the API starts.

## Accounts

See the [user guide](docs/user-guide.md) for a screenshot walkthrough.

Access is invite-only. Set `SETUP_TOKEN` in `.env` (16+ characters), start the stack, and open `/setup.html` to create the administrator; the setup page stops working as soon as any user exists. The admin page (`/admin.html`) creates single-use invite links (valid 72 hours) for other people.

- Passwords are hashed with argon2id; sessions are stored server-side and last 30 days (sliding). The browser holds only a random token in an httpOnly, SameSite=Lax cookie.
- `COOKIE_SECURE` defaults to `true`. If you serve plain HTTP on a LAN address, set it to `false`; prefer HTTPS via a reverse proxy.
- Login attempts are rate limited in memory per IP and per username (the limits reset when the API restarts). After 8 failures a username is locked for 15 minutes, so someone who knows a username can temporarily block that login.
- The API sits behind the web container's proxy, so `TRUST_PROXY=true` is set in compose to read the client IP from `X-Forwarded-For`. The API port is also published; do not expose it beyond your trusted network, because a direct caller could spoof that header and sidestep the per-IP limit.
- Rollback: `npm --prefix api run migrate -- down` drops the `users`, `sessions` and `invites` tables, which deletes all accounts.

## Card data

Cards and editions come from a snapshot of [dennisgermany/dominion](https://github.com/dennisgermany/dominion) (MIT licence; see `db/data/NOTICE.md`): 852 cards across 24 editions, with names, costs, types and edition membership but no card text. `docker compose up` imports it automatically through the `import-cards` service, and you can re-run it at any time without duplicating anything:

    npm --prefix api run import-cards

The snapshot is kept exactly as published. Fixes go in `db/data/corrections.json`, each with the types it replaces, the types it sets, the reason, and the sources that agree. A correction fails the import if the card or its current types no longer match, so a stale fix cannot be applied silently. Two are recorded so far: Ambassador (adds Attack) and Island (adds Action), both confirmed against two other public card lists.

Cost notation is parsed into coins, potions, debt and a "variable cost" flag (`3`, `2P`, `D8`, `8*`); an unknown notation stops the import. Cards that disappear from a later snapshot are kept in the database and counted in the import log, because later features may refer to them.

The API (sign-in required) offers `GET /cards` (filters `q`, `edition`, `type`, `minCost`, `maxCost`, `potion`, `kingdom`, `limit`, `offset`; unknown parameters are rejected), `GET /cards/:id`, `GET /editions` and `GET /card-types`. Rollback of the card tables: `npm --prefix api run migrate -- down` (removes the latest migration only).

## Card pictures

Card pictures are copyrighted artwork, so they are not part of this project, its Docker images or (from now on) its git history. You host them yourself in a folder and the web container serves it read-only at `/cards/`.

- Put one file per card in the folder, named after the card in lower case with dashes and no apostrophes: `copper.webp`, `kings-court.webp`, `death-cart.jpg`. `.webp`, `.jpg` and `.png` are supported (tried in that order). The API reports each card's expected name as `imageSlug`.
- Point compose at the folder with `CARDS_DIR` in `.env` (default `./cards`). On Unraid use a path such as `/mnt/user/appdata/dominion/cards`. The folder is mounted read-only, and the files must be readable by other users (for example `chmod -R a+rX`) because the web server does not run as root.
- Nothing is loaded until you press **Show picture** on a card in the card browser, so a missing picture costs nothing. If the file is not found, the page says which file name to add.
- Only plain picture file names under `/cards/` are served; directory listings and any other file type return 404. `cards/*.webp`, `.jpg` and `.png` are git-ignored so pictures are not committed by accident. (`cards/copper.webp`, added earlier, is already in the history; remove it with `git rm --cached cards/copper.webp` if you want it out of future commits.)
- Pictures can be large (the Copper file is about 0.5 MB), so shrinking them to roughly 400 px wide keeps pages light.

## Tests

    npm --prefix api ci && npm --prefix api test
    TEST_DB_HOST=127.0.0.1 TEST_DB_USER=... TEST_DB_PASSWORD=... TEST_DB_NAME=... npm --prefix api test   # includes MySQL migration tests
    python -m venv .venv && .venv/bin/pip install -r sim/requirements-dev.txt && (cd sim && ../.venv/bin/python -m pytest)
    npm --prefix web ci && npm --prefix web run typecheck

The MySQL-backed tests drop and recreate `schema_migrations`, the account and card tables, `widget` and `gadget`; point them at a throwaway database.
