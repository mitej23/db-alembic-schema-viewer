# Product plan — Persistent cache + branch-aware history

> Status: proposal · Author: mitej · Last updated: 2026-05-09

## What we're building (one line)

Cache every successful schema fetch in a local SQLite file so the studio
opens instantly the next time, and remember the git branch the code was on
since `--models` produces different schemas across branches.

## Why

Today, every `studio` run re-runs reflection or re-imports models. That's:

- **Wasted time** — reflecting a 50-table Postgres takes seconds; running it
  every time you peek at the schema is needless.
- **Lossy across branches** — `--models app.db.schema` on `feature/budget`
  gives a different schema than on `main`. Switching branches today loses
  the previous view.
- **Unreliable when offline** — VPN drops, prod is firewalled, you're on a
  plane. You still want to look at yesterday's schema.

A small SQLite file at `~/.local/share/schema-viewer/cache.db` solves all
three. Nothing more grand than that. No version control metaphor, no diff
as the headline, no collaboration — just a cache that's smart enough to
keep one entry per project per branch per source.

## Scope

### In scope (this plan)

- Auto-save the result of every successful fetch
- Open from cache when nothing has materially changed
- Branch-aware storage (capture git branch + commit at fetch time)
- Two parallel lanes per project: `models` and `database`, never mixed
- Manual refresh (re-fetch) from the studio

### Out of scope

- Diff/compare as a headline feature (possible later — see "Adjacent
  possibilities" — but it's a *bonus*, not the reason this exists)
- Multi-user / collaboration / sharing snapshots between developers
- Cloud sync, push/pull, remote storage
- Schema editing or migration generation

## Data model — `~/.local/share/schema-viewer/cache.db`

One SQLite file on the user's machine. Single source of truth across all
their projects. Schema small enough that it doesn't need compression.

```sql
-- Every project the tool has touched, keyed by absolute path.
CREATE TABLE projects (
  id           INTEGER PRIMARY KEY,
  path         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

-- One row per fetch. A "lane" is the (source_type, source_target, source_env)
-- triple — distinct lanes never overwrite each other.
CREATE TABLE entries (
  id                INTEGER PRIMARY KEY,
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  source_type       TEXT NOT NULL,        -- 'models' | 'database'
  source_target     TEXT NOT NULL,        -- 'app.db.schema' or 'postgresql://***@host/db'
  source_env        TEXT,                 -- optional label: 'prod' | 'staging' | 'local'

  branch            TEXT,                 -- 'main', null if not in a git repo / detached
  commit_sha        TEXT,
  is_dirty          INTEGER NOT NULL DEFAULT 0,

  schema_json       TEXT NOT NULL,        -- the Pydantic Schema, serialized
  migrations_json   TEXT,                 -- Migration[] or null
  current_revision  TEXT,
  table_count       INTEGER NOT NULL,
  content_hash      TEXT NOT NULL,        -- sha256(schema_json) — for dedupe
  fetched_at        TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_lane_branch
  ON entries(project_id, source_type, source_target, source_env, branch);
```

The unique index is the key design choice: **one row per
`(project, lane, branch)`**. A fresh fetch on the same triple updates the
existing row in place. We're not building a full history of every fetch
ever; we're building a *cache*.

If the user wants more history later (Phase 2 below), we drop the unique
index and add a retention policy. But for v1, "latest per lane per branch"
is enough.

## CLI surface

### Existing — `studio`, with cache behavior added

```bash
# default — fetch fresh, write to cache, open browser
schema-viewer studio --models app.db.schema

# open whatever's in cache for current dir + branch; fail if nothing cached
schema-viewer studio --from-cache

# open from cache, fall back to fresh fetch if cache miss
schema-viewer studio --cache-first

# don't write to cache (e.g. one-off DB peek)
schema-viewer studio --no-cache

# tag the cache entry — useful for distinguishing prod/staging DB lanes
schema-viewer studio --env prod --db-url "$PROD_URL"
```

### New commands

```bash
schema-viewer cache list           # show cached entries for current project
schema-viewer cache list --all     # across all projects on this machine
schema-viewer cache clear          # wipe current project's entries
schema-viewer cache clear --all    # wipe everything (asks first)
schema-viewer cache path           # print the SQLite file path
```

### Sample output

```
$ schema-viewer cache list
cache for /Users/mitej/.../mymanifest-backend

  LANE                       BRANCH       TABLES   FETCHED
  models · app.db.schema     main *       15       2 min ago
  models · app.db.schema     feat/budget  16       yesterday 22:14
  database · prod            (n/a)        15       5 min ago

  * = current branch
```

## Studio UI — minimal additions

### Top bar

- **State pill** next to the existing `N tables` pill:
  - `live · just now` (fresh fetch this session)
  - `cached · 2 min ago` (loaded from cache)
- The existing **refresh icon** does what it says: re-fetch, update the
  cache, redraw. No new buttons.

### Branch indicator (only if multiple branches in cache for this project)

A tiny dropdown next to the state pill listing branches that have entries:

```
  ┌──────────────────────────┐
  │ branch: main *           │
  ├──────────────────────────┤
  │   main *  (current)      │
  │   feat/budget            │
  └──────────────────────────┘
```

Switch via the dropdown to view another branch's cached schema without
checking out the branch. Picks the entry from cache; shows
`cached · yesterday 22:14`.

### Empty state

If user opens `studio` on a branch with no cached entry: render an empty
canvas with a friendly prompt — "no cached schema for branch `feat/x`.
Press Refresh or run `schema-viewer studio --models app.db.schema` to
capture."

## Branch handling

```python
def git_context(cwd: Path) -> GitContext:
    """Capture branch + SHA + dirty flag at fetch time. Tolerates non-git dirs."""
    if not _is_git_repo(cwd):
        return GitContext(branch=None, sha=None, dirty=False)
    branch = run("git symbolic-ref --short HEAD", cwd=cwd) or None  # None on detached HEAD
    sha    = run("git rev-parse HEAD", cwd=cwd) or None
    dirty  = bool(run("git status --porcelain", cwd=cwd))
    return GitContext(branch=branch, sha=sha, dirty=dirty)
```

Edge cases handled gracefully:
- Not a git repo → `branch=None`. Cache stores under `branch=NULL`. Reopening
  uses that entry.
- Detached HEAD → `branch=None`, sha set. Same behavior.
- Worktrees → each captures its own branch independently.

The DB lane (`source_type='database'`) ignores branch — DBs don't know your
branch. Stored with `branch=NULL` always.

## The two lanes — not mixed, both first-class

| Aspect              | `models` lane                                 | `database` lane                            |
| ------------------- | --------------------------------------------- | ------------------------------------------ |
| Source              | Python source code at HEAD                    | Live DB schema                             |
| Branch-sensitive    | **Yes** — different branches → different rows | No — DB doesn't know your branch           |
| Env-sensitive       | No                                            | **Yes** — `--env prod` vs `--env staging`  |
| Speed (fresh fetch) | Fast (no network)                             | Slower (network round-trip)                |
| Captures intent     | Yes                                           | No                                         |
| Captures drift      | No                                            | Yes (anything ad-hoc done on the DB)       |

The history sheet shows them as separate streams. They never get merged or
compared by default. Lanes are listed; you pick which one to view.

## Phased rollout

### Phase 1 — write to cache (~2 days)

- `services/cache.py`: SQLite init, write, read latest by lane+branch
- Auto-save inside `studio` after each successful fetch
- `cache list`, `cache clear`, `cache path` CLI commands
- No UI changes; the cache silently accumulates

Ships value: the very next run starts being recorded. Nothing breaks, nothing
visible — but every future feature builds on this.

### Phase 2 — open from cache (~3 days)

- `studio --from-cache` and `studio --cache-first`
- `/api/cache/entries` for the studio
- Top-bar state pill (`live` / `cached`)
- Refresh button updates cache too
- Empty state for "no cached entry on this branch"

This is where users feel it. Re-opens take ~100ms instead of seconds.

### Phase 3 — branch UI (~2 days)

- Branch dropdown in the top bar
- Loading another branch's entry without re-fetching
- "Switching branch will load cached schema for `feat/x`" tooltip

After Phase 3, the core ask is done.

### Phase 4 — polish

- Optional retention beyond "latest per lane per branch" (drop the unique
  index, add a `keep last N` policy) — only if a real need shows up
- `--label` for human-tagged entries
- `cache export <path>` / `cache import <path>` (single-machine — for
  swapping laptops, not for collaboration)

## Adjacent possibilities (single-user, post-cache)

Once the cache exists, a handful of features become almost-free. None of
these are the headline — they're things to *consider* once Phase 1-3 ships:

- **Offline mode** — `--from-cache` already gives you this for free. Worth
  documenting prominently.
- **Multi-environment side-by-side** — the DB lane already handles this via
  `--env`. UI could let you flip between `local`, `staging`, `prod` quickly.
- **Compare two cached entries** — given the data is already there, a one-off
  diff (`models@main` vs `database@prod`) is a small extra feature, not a
  framework. Could ship as a CLI-only `cache diff @main @prod` initially.
- **Drift signal** — same data, different question: "is the schema in
  `database@prod` consistent with `models@main`?" A single yes/no in the
  status bar. No diff UI needed for the basic version.
- **Schema warnings** — heuristics over a single cached entry: "table
  `users` has no PK", "column has nullable boolean (probably wrong)". Small,
  unrelated to the cache structurally; can ship anytime.
- **Time-travel via Alembic replay** — apply the migration history to an
  in-memory SQLite, capture the schema at any historical revision into the
  same cache. Lets the studio show "schema at revision 0042" without ever
  touching prod. Heavier feature; a Phase 4+ item.
- **Markdown / mermaid export** — given a cached entry, render a docs-friendly
  representation. Useful for PR descriptions and design docs. Cache is
  tangential — but having a stable input makes the export trivial.

These are options, not commitments. The plan ends at Phase 3.

## Risks & tradeoffs

| Risk                                | Mitigation                                              |
| ----------------------------------- | ------------------------------------------------------- |
| Cache grows unbounded               | Unique index keeps to one row per lane+branch (Phase 1) |
| Schemas with sensitive comments     | Document; offer `--redact-comments` if asked            |
| Project moved on disk               | Re-key by basename + remote_url fallback; `cache forget` |
| Concurrent writes to SQLite         | WAL mode + short transactions                           |
| Stale cache vs current code         | Pill says `cached · 2h ago`; refresh is one click       |
| Code-based fetch breaks (import err)| Don't write to cache; show error; cache remains intact  |

## Decisions to make before building

1. **Cache location** — `~/.local/share/schema-viewer/cache.db` (XDG; works
   for macOS too despite the Linux-flavored path) vs platform-specific
   (`~/Library/Application Support/...` on Mac).
   Recommend: XDG. Single behavior across machines.

2. **Auto-cache on by default?**
   Recommend: yes. Most invocations should write. `--no-cache` for opt-out.

3. **What if the cache is corrupted?**
   Recommend: detect on open, rename to `cache.db.bak`, recreate empty,
   warn once. Never block the user.

4. **Phase 1 ships UI changes too, or hold them for Phase 2?**
   Recommend: hold. Phase 1 is silent, only the CLI gets new commands. UI
   waits for Phase 2 so it's a single visible release.

## What I'd build first

If we ship Phase 1 + Phase 2 only:

> User runs `schema-viewer studio --models app.db.schema` once on `main`.
> Closes the tab. Tomorrow runs `schema-viewer studio --from-cache` from the
> same directory — browser opens in 200ms with exactly what they saw. They
> switch to `feat/budget` and run it again with `--models app.db.schema`;
> now both branches are in the cache. They flip the branch dropdown to peek
> at `main` without checking it out.

That alone is the entire ask. Nothing else needs to ship for this to feel
like a real upgrade.
