# db-alembic-schema-viewer

A read-only schema visualizer for Python projects using **SQLAlchemy** and
**Alembic**. Drop into any project, run one command, and get an interactive ER
diagram in your browser — with FK arrows, search, dark mode, and the full
Alembic migration history a click away.

![schema-viewer screenshot](./docs/screenshot.png)

```
┌─────────────────────────┐    ┌────────────────────────┐
│  SQLAlchemy MetaData    │ ─▶ │                        │
│  (or live DB reflect)   │    │   FastAPI (localhost)  │ ─▶ Browser
│  Alembic ScriptDir      │ ─▶ │                        │     (React Flow)
└─────────────────────────┘    └────────────────────────┘
```

It's a dev tool. No data is ever written — the inspector calls
`MetaData.reflect()` and reads `alembic_version`, nothing more.

## Quick start

```bash
# install once, globally, isolated from any project
brew install pipx                     # if you don't have it
pipx install git+https://github.com/mitej23/db-alembic-schema-viewer.git
pipx inject schema-viewer psycopg2-binary    # or pymysql for MySQL

# then in any SQLAlchemy + Alembic project:
cd path/to/your/project
schema-viewer studio --models app.db.schema --alembic-ini alembic.ini
# or, if you'd rather just point at a live DB:
schema-viewer studio --db-url "$DATABASE_URL"
```

The browser opens at `http://127.0.0.1:5555`. `Ctrl+C` to stop.

## Try the demo first

```bash
git clone https://github.com/mitej23/db-alembic-schema-viewer.git
cd db-alembic-schema-viewer
pipx install .
schema-viewer studio --models examples.sample_models:Base
```

You'll see a 6-table sample schema (users, listings, bookings, payments…) with
all the FK arrows wired up.

## Two ways to point it at your project

### A. Reflect from a live database (zero project changes)

```bash
schema-viewer studio --db-url postgresql://user:pass@host:5432/dbname
# or use $DATABASE_URL from your .env:
set -a && source .env && set +a
schema-viewer studio --db-url "$DATABASE_URL" --alembic-ini alembic.ini
```

**Async URLs are auto-normalized.** Paste `postgresql+asyncpg://`,
`mysql+aiomysql://`, or `sqlite+aiosqlite://` as-is — the tool swaps in the
default sync driver (psycopg2 / pymysql / sqlite) before reflecting.

### B. Load from SQLAlchemy models

Two forms:

```bash
# Explicit — point at a Base or MetaData attribute
schema-viewer studio --models app.db.models:Base

# Auto-discovery — point at a *package*; the tool walks every submodule,
# imports them all, and merges metadata from every Base it finds.
schema-viewer studio --models app.db.schema
```

Auto-discovery is the universal form: works whether you have one `Base`,
multiple `Base`s, or models scattered across files that aren't imported from
`__init__.py`. It also sidesteps the "did `Base.metadata` actually get
populated?" gotcha that bites people writing Alembic autogenerate migrations.

The viewer reads `alembic.ini` from the current directory automatically; pass
`--alembic-ini path/to/alembic.ini` if it's somewhere else.

### C. Combined (best of both)

Models for the source of truth + DB so the migrations panel can mark which
revisions are applied:

```bash
schema-viewer studio \
  --models app.db.schema \
  --db-url "$DATABASE_URL" \
  --alembic-ini alembic.ini
```

## Options

| Flag                  | Default        | Description                                          |
| --------------------- | -------------- | ---------------------------------------------------- |
| `-m, --models`        | —              | `pkg.module:attr` (explicit) or `pkg` (walks package) |
| `-d, --db-url`        | `$DATABASE_URL`| Connection URL (async drivers auto-normalized)       |
| `-a, --alembic-ini`   | `alembic.ini`  | Path to `alembic.ini` (auto-detected if present)     |
| `-s, --schema`        | —              | DB schema name for reflection (e.g. `public`)        |
| `--host`              | `127.0.0.1`    | Bind host (loopback only by default)                 |
| `-p, --port`          | `5555`         | Bind port                                            |
| `--no-browser`        | off            | Don't auto-open the browser                          |

## What you see

- **Canvas** — every table as a card; columns with PK / FK / UQ / nullable
  flags; FK relationships drawn column-to-column with arrows. Click a table
  to highlight it; the canvas pans smoothly to it.
- **Sidebar** — searchable table list. Each row is collapsible — click the
  chevron to expand and see all columns inline (with type and PK/FK flags).
  Cmd+K focuses the search.
- **Migrations sheet** — slides in from the right. Full Alembic revision
  history with applied / pending / head tags. Click any revision to drill in
  and view the migration source. Esc takes you back, Esc again closes the
  sheet.
- **Theme** — light + dark with a sun/moon toggle. Defaults to your OS
  preference; the choice persists.

## Working with arbitrary projects

Real Python projects vary in three ways the tool handles transparently:

**1. Where `Base` lives.** Some projects expose it from a models package's
`__init__.py`; others keep it in `db.py`. The auto-discovery form
(`--models pkg`) doesn't care — it walks the whole package and finds every
Base.

**2. How models register.** SQLAlchemy only knows about tables whose model
classes have been imported. If your project's `__init__.py` doesn't
side-effect-import every model module, an explicit `--models pkg.module:Base`
will give you a partial schema. Auto-discovery solves this.

**3. Async drivers.** `postgresql+asyncpg://` and friends are normalized to
sync drivers automatically. You don't need a second URL.

### When `--models` fails because the project has third-party deps

`schema-viewer` runs in its own pipx environment. When it imports your
models, Python tries to import everything those models import — including
project-specific deps (`logfire`, `redis`, `boto3`, etc.). If any of those
aren't in schema-viewer's env, you'll get a clear error with three options:

1. **Add the missing dep to schema-viewer's env**:
   ```bash
   pipx inject schema-viewer logfire redis
   ```
   (Persistent — only do this once per project.)
2. **Install schema-viewer into your project's venv** instead, so your
   project's deps are available:
   ```bash
   source .venv/bin/activate
   pip install -e /path/to/db-alembic-schema-viewer
   ```
3. **Bypass imports entirely** with `--db-url $DATABASE_URL`. Often the
   simplest first run.

## How it works

1. The CLI imports your declarative `Base` (with `cwd` on `sys.path`) — or
   walks the package and finds every Base — or opens a SQLAlchemy connection
   and calls `MetaData.reflect()`.
2. A FastAPI app on `127.0.0.1` exposes:
   - `GET /api/schema`     → table/column/FK/index JSON
   - `GET /api/migrations` → Alembic revisions, with `is_applied` populated
     by reading `alembic_version` from the live DB (read-only)
   - `GET /api/migrations/{rev}/source` → the migration file contents
3. The browser loads a single static page that fetches the JSON and renders
   an interactive React Flow diagram, laid out with Dagre.

The frontend uses an import map to load React, React Flow, and Dagre from
`esm.sh` at runtime. There is **no Node build step** — modify `static/app.js`
and reload the page.

## Architecture

```
src/schema_viewer/
├── cli.py                # `schema-viewer studio` entrypoint
├── server.py             # FastAPI app + Settings
├── models.py             # Pydantic response schemas
├── inspectors/
│   ├── sqlalchemy.py     # explicit + package-walk discovery
│   ├── database.py       # live introspection + async URL normalization
│   └── alembic.py        # migration history + applied state
└── static/               # served as-is
    ├── index.html        # import map for esm.sh
    ├── styles.css        # shadcn tokens, light + dark
    └── app.js            # React + React Flow (htm template literals)
```

## Read-only guarantees

- No `INSERT` / `UPDATE` / `DELETE` / DDL is ever issued. The DB inspector
  only calls `MetaData.reflect()`; the migration inspector only reads
  `alembic_version`.
- The server binds to `127.0.0.1` (loopback) by default — nothing is exposed
  to your LAN unless you pass `--host 0.0.0.0`.
- No state is persisted on disk by the tool itself.
- The frontend has no write affordances.

## Limitations

- View-only by design. No DDL diffing, no migration generation, no editing.
- Cross-schema FKs are rendered, but reflection requires the schema name
  passed via `--schema` for non-default schemas.
- Views, materialized views, sequences, and custom types are not shown.
- Dagre layout is automatic; positions don't persist across reloads.

## License

MIT — see [LICENSE](./LICENSE).
