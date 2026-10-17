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

## Tests

    npm --prefix api ci && npm --prefix api test
    TEST_DB_HOST=127.0.0.1 TEST_DB_USER=... TEST_DB_PASSWORD=... TEST_DB_NAME=... npm --prefix api test   # includes MySQL migration tests
    python -m venv .venv && .venv/bin/pip install -r sim/requirements-dev.txt && (cd sim && ../.venv/bin/python -m pytest)
    npm --prefix web ci && npm --prefix web run typecheck

The MySQL-backed tests drop and recreate `schema_migrations`, `widget` and `gadget`; point them at a throwaway database.
