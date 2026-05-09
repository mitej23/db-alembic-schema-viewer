import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__
from .cache import CacheEntry, CacheStore, GitContext
from .git_context import git_context, project_root
from .inspectors.alembic import get_current_revision, list_migrations
from .inspectors.database import inspect_database, safe_url, to_sync_url
from .inspectors.sqlalchemy import inspect_models
from .models import Migration, Schema

STATIC_DIR = Path(__file__).parent / "static"


@dataclass
class Settings:
    """Runtime settings. `mode` decides the server's posture.

    studio: live source attached; can fetch + auto-cache.
    dashboard: no live source; only the cache is exposed.
    """
    mode: Literal["studio", "dashboard"]
    cwd: Path
    models: Optional[str] = None
    db_url: Optional[str] = None
    alembic_ini: Optional[str] = None
    schema: Optional[str] = None
    env: Optional[str] = None
    auto_cache: bool = True
    project: Path = field(init=False)
    git: GitContext = field(init=False)

    def __post_init__(self) -> None:
        if self.mode == "studio" and not self.models and not self.db_url:
            raise ValueError("studio mode requires `models` or `db_url`.")
        self.project = project_root(self.cwd)
        self.git = git_context(self.cwd)


def create_app(settings: Settings) -> FastAPI:
    app = FastAPI(
        title="Schema Viewer",
        version="0.3.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    cache = CacheStore()

    # ── Info ─────────────────────────────────────────────────────────────

    @app.get("/api/info")
    def info() -> dict:
        return {
            "mode": settings.mode,
            "auto_cache": settings.auto_cache,
            "project": {
                "path": str(settings.project),
                "name": settings.project.name,
                "branch": settings.git.branch,
                "commit_sha": settings.git.commit_sha,
                "is_dirty": settings.git.is_dirty,
            },
            "source": _source_payload(settings),
        }

    # ── Live fetch + auto-cache (studio only) ────────────────────────────

    if settings.mode == "studio":
        @app.get("/api/schema", response_model=Schema)
        def get_schema() -> Schema:
            schema, current_rev = _fetch_live_schema(settings)
            migrations = _fetch_migrations(settings)
            if settings.auto_cache:
                _save_to_cache(cache, settings, schema, migrations, current_rev)
            return schema

        @app.get("/api/migrations", response_model=list[Migration])
        def get_migrations() -> list[Migration]:
            return _fetch_migrations(settings)

        @app.get("/api/migrations/{revision}/source")
        def get_migration_source(revision: str) -> dict:
            if not settings.alembic_ini:
                raise HTTPException(status_code=404, detail="Alembic not configured")
            for m in list_migrations(settings.alembic_ini):
                if m.revision == revision and m.file:
                    try:
                        return {"revision": revision, "source": Path(m.file).read_text()}
                    except OSError as exc:
                        raise HTTPException(status_code=500, detail=str(exc)) from exc
            raise HTTPException(status_code=404, detail="Revision not found")

    # ── Cache (always available) ─────────────────────────────────────────

    @app.get("/api/cache/projects")
    def cache_projects() -> list[dict]:
        return cache.list_projects()

    @app.get("/api/cache/projects/{project_id}/entries")
    def cache_project_entries(project_id: int) -> list[dict]:
        return cache.list_entries(project_id)

    @app.get("/api/cache/entries/{entry_id}")
    def cache_entry(entry_id: int) -> dict:
        entry = cache.get_entry(entry_id)
        if not entry:
            raise HTTPException(status_code=404, detail="Entry not found")
        return _entry_payload(entry)

    @app.get("/api/cache/entries/{entry_id}/source")
    def cache_entry_migration_source(entry_id: int, revision: str = Query(...)) -> dict:
        """Migration source for cached entries.

        Cached migration source is only available if alembic.ini is reachable
        on this machine at the project's path; otherwise we can only return
        what's in the cached migrations_json (which has the file path).
        """
        entry = cache.get_entry(entry_id)
        if not entry:
            raise HTTPException(status_code=404, detail="Entry not found")
        for m in entry.migrations:
            if m.get("revision") == revision and m.get("file"):
                try:
                    return {"revision": revision, "source": Path(m["file"]).read_text()}
                except OSError as exc:
                    raise HTTPException(status_code=404, detail=f"Source file missing: {exc}")
        raise HTTPException(status_code=404, detail="Revision not found in cache")

    @app.get("/api/cache/find")
    def cache_find(
        source_type: Optional[str] = None,
        branch: Optional[str] = None,
    ) -> dict:
        """Find latest cached entry for the *current* project (if studio mode)."""
        if settings.mode != "studio":
            raise HTTPException(status_code=400, detail="Only available in studio mode")
        e = cache.find_latest(
            project_path=settings.project,
            source_type=source_type,
            branch=branch,
        )
        if not e:
            raise HTTPException(status_code=404, detail="No cached entry matches")
        return _entry_payload(e)

    # ── Filesystem browse + auto-detect (localhost-only convenience) ────

    @app.get("/api/fs/list")
    def fs_list(path: str = Query("~"), include_hidden: bool = Query(False)) -> dict:
        target = _expand(path)
        if not target.exists() or not target.is_dir():
            raise HTTPException(status_code=404, detail=f"Not a directory: {target}")
        entries = []
        try:
            for child in sorted(target.iterdir(), key=lambda p: p.name.lower()):
                if not include_hidden and child.name.startswith("."):
                    continue
                try:
                    is_dir = child.is_dir()
                except OSError:
                    continue
                if not is_dir:
                    continue
                entries.append({
                    "name": child.name,
                    "path": str(child),
                    "has_alembic_ini": (child / "alembic.ini").exists(),
                    "has_pyproject": (child / "pyproject.toml").exists(),
                    "has_git": (child / ".git").exists(),
                })
        except PermissionError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        return {
            "path": str(target),
            "parent": str(target.parent) if target.parent != target else None,
            "home": str(Path.home()),
            "entries": entries,
        }

    @app.get("/api/fs/detect")
    def fs_detect(path: str = Query(...)) -> dict:
        target = _expand(path)
        if not target.exists() or not target.is_dir():
            raise HTTPException(status_code=404, detail=f"Not a directory: {target}")
        return _detect_project(target)

    # ── Programmatic fetch (powers the dashboard "Add project" flow) ────

    @app.post("/api/cache/fetch")
    def cache_fetch_endpoint(payload: FetchRequest) -> dict:
        return _do_fetch(cache, payload)

    # ── Static frontend ─────────────────────────────────────────────────

    if STATIC_DIR.exists():
        # Versioned asset cache key: file mtime per asset → URL changes whenever
        # the file on disk changes, so the browser is forced to re-fetch even
        # without a version bump.
        def asset_v(name: str) -> str:
            try:
                return f"{__version__}.{int((STATIC_DIR / name).stat().st_mtime)}"
            except OSError:
                return __version__

        app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

        @app.get("/")
        def root() -> Response:
            """Serve index.html with version-busted asset URLs.

            Two layers of cache discipline:
              1. The `?v=…` query string ensures any change to app.js / styles.css
                 invalidates the browser's cache key.
              2. We tell the browser never to cache index.html itself, so it
                 always revalidates and picks up the freshest asset URLs.
            """
            index = STATIC_DIR / "index.html"
            if not index.exists():
                raise HTTPException(status_code=500, detail="index.html missing from package")
            text = index.read_text(encoding="utf-8")
            text = text.replace(
                '/static/styles.css',
                f'/static/styles.css?v={asset_v("styles.css")}',
            ).replace(
                '/static/app.js',
                f'/static/app.js?v={asset_v("app.js")}',
            )
            return HTMLResponse(
                text,
                headers={
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache",
                    "Expires": "0",
                },
            )

    return app


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _source_payload(settings: Settings) -> Optional[dict]:
    if settings.mode != "studio":
        return None
    if settings.models:
        return {"type": "models", "target": settings.models, "env": settings.env}
    return {
        "type": "database",
        "target": safe_url(to_sync_url(settings.db_url)),  # type: ignore[arg-type]
        "env": settings.env,
    }


def _fetch_live_schema(settings: Settings) -> tuple[Schema, Optional[str]]:
    try:
        if settings.models:
            schema = inspect_models(settings.models)
        else:
            assert settings.db_url is not None
            schema = inspect_database(settings.db_url, schema=settings.schema)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Failed to inspect schema: {exc}") from exc

    current_rev: Optional[str] = None
    if settings.db_url and settings.alembic_ini:
        current_rev = get_current_revision(settings.db_url)
        schema.current_revision = current_rev
    return schema, current_rev


def _fetch_migrations(settings: Settings) -> list[Migration]:
    if not settings.alembic_ini:
        return []
    try:
        return list_migrations(settings.alembic_ini, db_url=settings.db_url)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Failed to load migrations: {exc}") from exc


def _save_to_cache(
    cache: CacheStore,
    settings: Settings,
    schema: Schema,
    migrations: list[Migration],
    current_rev: Optional[str],
) -> None:
    src = _source_payload(settings)
    if not src:
        return
    try:
        cache.upsert_entry(
            project_path=settings.project,
            source_type=src["type"],
            source_target=src["target"],
            source_env=settings.env,
            git=settings.git,
            schema=schema,
            migrations=migrations,
            current_revision=current_rev,
        )
    except Exception:
        # Cache failures must never break the live response.
        pass


def _expand(path: str) -> Path:
    """Resolve user input to an absolute path. Tolerant of `~`, relative, env vars."""
    return Path(os.path.expanduser(os.path.expandvars(path))).resolve()


def _detect_project(root: Path) -> dict:
    """Best-effort scan of a project directory to suggest config."""
    # 1. alembic.ini — root or one level deep
    alembic_ini: Optional[str] = None
    for cand in [root / "alembic.ini", *list(root.glob("*/alembic.ini"))]:
        if cand.exists():
            alembic_ini = str(cand.resolve())
            break

    # 2. .env — DATABASE_URL hint
    env_file = root / ".env"
    has_env = env_file.exists()

    # 3. Candidate model packages: directories under root that contain *.py
    #    importing 'sqlalchemy' or defining a Base. Walk up to 4 levels deep.
    candidates: list[dict] = []
    skip_names = {".venv", "venv", "env", "node_modules", "__pycache__", ".git", "tests", "test", "migrations"}
    seen: set[str] = set()
    max_depth = 4
    for py in root.rglob("*.py"):
        # skip noise
        rel = py.relative_to(root)
        if any(part in skip_names or part.startswith(".") for part in rel.parts[:-1]):
            continue
        if len(rel.parts) > max_depth:
            continue
        try:
            head = py.read_text(errors="ignore")[:4096]
        except OSError:
            continue
        if "sqlalchemy" not in head.lower():
            continue
        # Use the parent directory as a package candidate
        pkg_dir = py.parent
        if pkg_dir == root:
            continue
        rel_pkg = pkg_dir.relative_to(root)
        # Walk up to find package roots that contain __init__.py
        if not (pkg_dir / "__init__.py").exists():
            continue
        module_path = ".".join(rel_pkg.parts)
        if module_path in seen:
            continue
        seen.add(module_path)
        # Heuristic score: prefer 'schema', 'models', 'db'
        name_lower = pkg_dir.name.lower()
        score = 0
        if "schema" in name_lower: score += 3
        if "models" in name_lower: score += 3
        if "db" in name_lower: score += 1
        candidates.append({
            "module": module_path,
            "path": str(pkg_dir),
            "score": score,
        })

    candidates.sort(key=lambda c: (-c["score"], c["module"]))
    return {
        "path": str(root),
        "alembic_ini": alembic_ini,
        "has_pyproject": (root / "pyproject.toml").exists() or (root / "setup.py").exists(),
        "has_git": (root / ".git").exists(),
        "has_env": has_env,
        "candidate_models": candidates[:8],
    }


class FetchRequest(BaseModel):
    project_path: str
    source_type: Literal["models", "database"]
    source_target: str
    source_env: Optional[str] = None
    alembic_ini: Optional[str] = None
    db_schema: Optional[str] = None  # DB schema name for reflection (rarely needed)


def _do_fetch(cache: CacheStore, req: FetchRequest) -> dict:
    project = _expand(req.project_path)
    if not project.exists() or not project.is_dir():
        raise HTTPException(status_code=400, detail=f"Project path not a directory: {project}")

    if req.source_type == "database":
        # In-process: fast, doesn't need project Python deps.
        try:
            schema = inspect_database(req.source_target, schema=req.db_schema)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"DB reflect failed: {exc}") from exc

        migrations: list[Migration] = []
        current_rev: Optional[str] = None
        if req.alembic_ini and Path(req.alembic_ini).exists():
            try:
                migrations = list_migrations(req.alembic_ini, db_url=req.source_target)
            except Exception:
                pass
            try:
                current_rev = get_current_revision(req.source_target)
                schema.current_revision = current_rev
            except Exception:
                pass

        git = git_context(project)
        entry_id = cache.upsert_entry(
            project_path=project_root(project),
            source_type="database",
            source_target=safe_url(to_sync_url(req.source_target)),
            source_env=req.source_env,
            git=git,
            schema=schema,
            migrations=migrations,
            current_revision=current_rev,
        )
        return {"ok": True, "entry_id": entry_id, "table_count": len(schema.tables)}

    # source_type == 'models': spawn `schema-viewer fetch` subprocess in the project dir.
    args = [sys.executable, "-m", "schema_viewer", "fetch", "--json", "--models", req.source_target]
    if req.alembic_ini:
        args += ["--alembic-ini", req.alembic_ini]
    if req.source_env:
        args += ["--env", req.source_env]
    args += ["--cwd", str(project)]

    try:
        result = subprocess.run(
            args,
            cwd=str(project),
            capture_output=True,
            text=True,
            timeout=120.0,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail=f"Fetch timed out: {exc}") from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Subprocess failed: {exc}") from exc

    if result.returncode != 0:
        # Try to parse JSON error from stdout (when --json is honored)
        err = result.stdout.strip() or result.stderr.strip()
        try:
            data = json.loads(err.splitlines()[-1])
        except (json.JSONDecodeError, IndexError):
            data = {"error": err or "fetch failed"}
        raise HTTPException(status_code=500, detail=data)

    try:
        data = json.loads(result.stdout.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError):
        raise HTTPException(status_code=500, detail=f"could not parse fetch output: {result.stdout!r}")
    return data


def _entry_payload(entry: CacheEntry) -> dict:
    return {
        "id": entry.id,
        "project": {
            "id": entry.project_id,
            "path": entry.project_path,
            "name": entry.project_name,
        },
        "source_type": entry.source_type,
        "source_target": entry.source_target,
        "source_env": entry.source_env,
        "branch": entry.branch,
        "commit_sha": entry.commit_sha,
        "is_dirty": entry.is_dirty,
        "current_revision": entry.current_revision,
        "table_count": entry.table_count,
        "fetched_at": entry.fetched_at,
        "schema": entry.schema,
        "migrations": entry.migrations,
    }
