# db-alembic-schema-viewer

A read-only schema visualizer + persistent cache for Python projects using
**SQLAlchemy** and **Alembic**. Run one command from anywhere, browse all your
cached projects from a dashboard, click any snapshot to see its ER diagram —
with FK arrows, search, dark mode, **double-tap focus mode**, and the full
Alembic migration history a click away.

![schema-viewer screenshot](./docs/screenshot.png)

```
┌─────────────────────────┐    ┌────────────────────────┐    ┌──────────┐
│  SQLAlchemy MetaData    │ ─▶ │                        │ ─▶ │ Browser  │
│  (or live DB reflect)   │    │   FastAPI (localhost)  │    │ React    │
│  Alembic ScriptDir      │ ─▶ │   + SQLite cache       │    │ Flow     │
└─────────────────────────┘    └────────────────────────┘    └──────────┘
```

It's a dev tool. No data is ever written to the source DB — the inspector
calls `MetaData.reflect()` and reads `alembic_version`, nothing more. Snapshots
are persisted locally to `~/.local/share/schema-viewer/cache.db` for instant
re-opens.

## Quick start

```bash
# install once, globally, isolated from any project
brew install pipx                     # if you don't have it
pipx install git+https://github.com/mitej23/db-alembic-schema-viewer.git
pipx inject schema-viewer psycopg2-binary    # or pymysql for MySQL

# from anywhere — opens the dashboard with all your cached projects:
schema-viewer
```

That's the whole interactive flow. The dashboard lets you **+ Add project** by
browsing to a folder, picking the schema package via a nested folder picker,
and one-click **Fetch & open** — no terminal-flipping required. Add an alias
if you want it shorter:

```bash
echo "alias sv='schema-viewer'" >> ~/.zshrc
```

To attach to a live source from the command line (and auto-cache the result):

```bash
cd path/to/your/project
schema-viewer studio --models app.db.schema     # walk a package, find Base
schema-viewer studio --db-url "$DATABASE_URL"   # reflect from a live DB
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

## Commands

```bash
schema-viewer                         # opens the dashboard (default)
schema-viewer dashboard               # explicit dashboard launch
schema-viewer studio --models PKG     # attach to a live source + cache
schema-viewer studio --db-url URL     # attach to a live DB + cache
schema-viewer fetch --models PKG      # fetch + cache + exit (no browser)
schema-viewer cache list              # list cached entries for cwd
schema-viewer cache list --all        # across all projects
schema-viewer cache clear             # clear current project's entries
schema-viewer cache forget PATH       # remove a project from the cache
schema-viewer cache path              # print the SQLite cache path
```

### `studio` flags

| Flag                  | Default        | Description                                            |
| --------------------- | -------------- | ------------------------------------------------------ |
| `-m, --models`        | —              | `pkg.module:attr` (explicit) or `pkg` (walks package)  |
| `-d, --db-url`        | `$DATABASE_URL`| Connection URL (async drivers auto-normalized)         |
| `-a, --alembic-ini`   | `alembic.ini`  | Path to `alembic.ini` (auto-detected if present)       |
| `-s, --schema`        | —              | DB schema name for reflection (e.g. `public`)          |
| `--env`               | —              | Optional label (`prod`, `staging`, `local`) for the lane|
| `--no-cache`          | off            | Don't write the fetch to the cache                     |
| `--host`              | `127.0.0.1`    | Bind host (loopback only by default)                   |
| `-p, --port`          | `5555`         | Bind port                                              |
| `--no-browser`        | off            | Don't auto-open the browser                            |

## What you see

### Dashboard (`schema-viewer`)

- One-line **project list** — every project you've ever fetched, with one row
  per cached snapshot showing lane (models / database), branch, source target,
  table count, and time since last fetch. Click any row to open it.
- **+ Add project** — slides in a wizard. Step 1: browse to your project's
  root (chip flags show which folders have `alembic.ini` / `pyproject.toml` /
  `.git`). Step 2: a **nested folder picker** lets you click into the schema
  folder; the dotted Python module path (`app.db.schema`) is computed
  automatically. Live "WILL RUN" preview shows the exact command before you
  fetch.
- **Auto-detection** — when you pick a project, the tool scans for
  `alembic.ini`, `.env`, and the most likely model packages (ranked by name).

### Studio (the diagram view)

- **Canvas** — every table as a card; columns with PK / FK / UQ / nullable
  flags; FK relationships drawn column-to-column with arrows. Click a table
  to highlight it; the canvas pans smoothly to it.
- **Double-tap focus mode** — double-click any table to isolate it. The
  focused table gets a **double border**, every other table fades to ~18%
  opacity, and only edges that touch the focused table stay visible. Great
  for tracing data flow ("what does `bookings` connect to?"). A banner at the
  top says "Focused on X · showing direct connections only" — double-tap
  again, click "Clear", or press **Esc** to toggle it off.
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

1. **Source resolution** — the CLI either imports your declarative `Base`
   (with `cwd` on `sys.path`), walks a package and finds every Base, or
   opens a SQLAlchemy connection and calls `MetaData.reflect()`.
2. **Persistence** — every successful fetch writes to a local SQLite cache
   at `~/.local/share/schema-viewer/cache.db`. There's at most one row per
   `(project, lane, branch)` triple — fresh fetches update in place.
3. **Server** — a FastAPI app on `127.0.0.1` exposes:
   - `GET /api/schema` (studio mode) → live fetch + auto-cache
   - `GET /api/cache/projects` and `/api/cache/entries/{id}` → browse cache
   - `POST /api/cache/fetch` → "Add project" wizard backend
   - `GET /api/fs/list`, `/api/fs/detect` → folder browser + project scan
   - `GET /api/migrations`, `/api/migrations/{rev}/source` → Alembic data
4. **Frontend** — a single static page with hash routing (`/`, `/live`,
   `/entry/<id>`). Renders the dashboard or studio depending on the route.
   React + React Flow + Dagre loaded from `esm.sh` at runtime — **no Node
   build step**.

## Architecture

```
src/schema_viewer/
├── cli.py                # CLI: dashboard, studio, fetch, cache
├── server.py             # FastAPI app: studio + cache + fs endpoints
├── cache.py              # SQLite cache layer
├── git_context.py        # branch / commit SHA / dirty flag capture
├── models.py             # Pydantic response schemas
├── inspectors/
│   ├── sqlalchemy.py     # explicit + package-walk discovery
│   ├── database.py       # live introspection + async URL normalization
│   └── alembic.py        # migration history + applied state
└── static/
    ├── index.html        # import map for esm.sh, pre-paint theme init
    ├── styles.css        # shadcn-style tokens, light + dark
    └── app.js            # Dashboard + Studio with hash routing (htm)
```

The cache schema:

```sql
projects(id, path, name, created_at)
entries(id, project_id, source_type, source_target, source_env,
        branch, commit_sha, is_dirty, schema_json, migrations_json,
        current_revision, table_count, content_hash, fetched_at)
-- UNIQUE(project_id, source_type, source_target, source_env, branch)
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
