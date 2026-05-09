import json
import os
import sys
import webbrowser
from pathlib import Path

import click
import uvicorn

from .cache import CacheStore, cache_path
from .git_context import git_context, project_root
from .inspectors.database import safe_url, to_sync_url
from .server import Settings, create_app


# ─── Help/error helpers ─────────────────────────────────────────────────────


def _running_under_pipx() -> bool:
    return "pipx/venvs/schema-viewer" in sys.executable.replace("\\", "/")


def _print_module_not_found_help(missing: str, models_target: str) -> None:
    is_pipx = _running_under_pipx()
    fix_cmd = (
        f"pipx inject schema-viewer {missing}"
        if is_pipx
        else f"pip install {missing}"
    )

    click.echo("", err=True)
    click.secho(f"  ✗ missing dependency: {missing}", fg="red", bold=True, err=True)
    click.echo(
        f"    Loading {models_target!r} requires '{missing}', which isn't installed",
        err=True,
    )
    click.echo("    in schema-viewer's environment.", err=True)
    click.echo("", err=True)

    click.secho("  ▸ run this, then re-run schema-viewer:", bold=True, err=True)
    click.echo("", err=True)
    click.secho(f"      {fix_cmd}", fg="cyan", bold=True, err=True)
    click.echo("", err=True)

    click.secho("    alternatives:", dim=True, err=True)
    click.secho(
        "      • skip imports entirely (no inject needed):",
        dim=True,
        err=True,
    )
    click.secho(
        "          schema-viewer studio --db-url $DATABASE_URL",
        dim=True,
        err=True,
    )
    if is_pipx:
        click.secho(
            "      • or install schema-viewer into your project's venv to share its deps:",
            dim=True,
            err=True,
        )
        click.secho(
            "          (activate venv) pip install git+https://github.com/mitej23/db-alembic-schema-viewer.git",
            dim=True,
            err=True,
        )
    click.echo("", err=True)


def _serve(settings: Settings, host: str, port: int, no_browser: bool) -> None:
    app = create_app(settings)
    url = f"http://{host}:{port}"

    click.secho("\n  schema-viewer", fg="cyan", bold=True, nl=False)
    click.echo(f"  →  {url}")
    if settings.mode == "dashboard":
        click.echo(f"  mode:    dashboard")
        click.echo(f"  cache:   {cache_path()}")
    else:
        click.echo(f"  mode:    studio")
        if settings.models:
            click.echo(f"  source:  models  ({settings.models})")
        else:
            click.echo(f"  source:  database  ({safe_url(to_sync_url(settings.db_url))})")  # type: ignore[arg-type]
        if settings.git.branch:
            click.echo(
                f"  branch:  {settings.git.branch}"
                + (" (dirty)" if settings.git.is_dirty else "")
            )
        if settings.alembic_ini:
            click.echo(f"  alembic: {settings.alembic_ini}")
    click.echo()

    if not no_browser:
        webbrowser.open(url)

    uvicorn.run(app, host=host, port=port, log_level="warning")


# ─── Top-level group: bare invocation opens the dashboard ───────────────────


@click.group(invoke_without_command=True)
@click.version_option()
@click.pass_context
def main(ctx: click.Context) -> None:
    """schema-viewer — read-only SQLAlchemy/Alembic schema visualizer.

    Run with no arguments to open the cache dashboard. Use the `studio`
    subcommand to attach to a live source.
    """
    if ctx.invoked_subcommand is None:
        ctx.invoke(dashboard)


# ─── Dashboard command ──────────────────────────────────────────────────────


@main.command()
@click.option("--host", default="127.0.0.1", show_default=True)
@click.option("--port", "-p", default=5555, type=int, show_default=True)
@click.option("--no-browser", is_flag=True)
def dashboard(host: str, port: int, no_browser: bool) -> None:
    """Open the cache dashboard. No live source attached."""
    settings = Settings(mode="dashboard", cwd=Path.cwd())
    _serve(settings, host=host, port=port, no_browser=no_browser)


# ─── Studio command ─────────────────────────────────────────────────────────


@main.command()
@click.option(
    "--models",
    "-m",
    help=(
        "Python target for SQLAlchemy models. Two forms: "
        "'pkg.module:Base' (explicit) or 'pkg' (walks the package and merges "
        "all bases)."
    ),
)
@click.option(
    "--db-url",
    "-d",
    envvar="DATABASE_URL",
    help="Database connection URL (or set DATABASE_URL env var)",
)
@click.option(
    "--alembic-ini",
    "-a",
    default="alembic.ini",
    show_default=True,
    help="Path to alembic.ini",
)
@click.option(
    "--schema",
    "-s",
    default=None,
    help="Database schema name (e.g. 'public') for DB reflection",
)
@click.option(
    "--env",
    default=None,
    help="Optional human label for this source (e.g. 'prod', 'staging'). "
         "Lets multiple DB lanes coexist for the same project in cache.",
)
@click.option("--no-cache", is_flag=True, help="Don't write fetches to the cache")
@click.option("--host", default="127.0.0.1", show_default=True)
@click.option("--port", "-p", default=5555, type=int, show_default=True)
@click.option("--no-browser", is_flag=True)
def studio(
    models: str | None,
    db_url: str | None,
    alembic_ini: str,
    schema: str | None,
    env: str | None,
    no_cache: bool,
    host: str,
    port: int,
    no_browser: bool,
) -> None:
    """Attach to a live source (models or DB) and open the schema studio."""
    if not models and not db_url:
        click.echo(
            "error: provide --models or --db-url (or set DATABASE_URL),\n"
            "       or run `schema-viewer` without arguments to open the dashboard.",
            err=True,
        )
        sys.exit(2)

    if models:
        sys.path.insert(0, os.getcwd())

    alembic_path: str | None = None
    ap = Path(alembic_ini)
    if ap.exists():
        alembic_path = str(ap.resolve())
    elif alembic_ini != "alembic.ini":
        click.echo(f"error: alembic.ini not found at {alembic_ini}", err=True)
        sys.exit(2)

    settings = Settings(
        mode="studio",
        cwd=Path.cwd(),
        models=models,
        db_url=db_url,
        alembic_ini=alembic_path,
        schema=schema,
        env=env,
        auto_cache=not no_cache,
    )

    # Eagerly probe the source so misconfiguration fails on the CLI, not the browser.
    if models:
        try:
            from .inspectors.sqlalchemy import inspect_models
            inspect_models(models)
        except ModuleNotFoundError as exc:
            _print_module_not_found_help(exc.name or "<unknown>", models)
            sys.exit(1)
        except Exception as exc:  # noqa: BLE001
            click.secho(f"\n  error loading models {models!r}: {exc}", fg="red", err=True)
            click.echo(
                "  hint: schema-viewer accepts either 'pkg.module:Base' or just 'pkg' "
                "(walks the package and merges all bases).",
                err=True,
            )
            sys.exit(1)

    _serve(settings, host=host, port=port, no_browser=no_browser)


# ─── fetch (subprocess-friendly, no server) ─────────────────────────────────


@main.command()
@click.option("--models", "-m", help="'pkg.module:Base' or 'pkg' for auto-discovery")
@click.option("--db-url", "-d", envvar="DATABASE_URL")
@click.option("--alembic-ini", "-a", default="alembic.ini", show_default=True)
@click.option("--schema", "-s", default=None)
@click.option("--env", default=None, help="Optional env label (e.g. 'prod')")
@click.option("--json", "as_json", is_flag=True, help="Print JSON result on stdout")
@click.option("--cwd", "cwd_override", default=None, help="Run as if from this directory")
def fetch(
    models: str | None,
    db_url: str | None,
    alembic_ini: str,
    schema: str | None,
    env: str | None,
    as_json: bool,
    cwd_override: str | None,
) -> None:
    """Fetch and cache once, without starting a server. Used by the dashboard."""
    if not models and not db_url:
        click.echo("error: provide --models or --db-url", err=True)
        sys.exit(2)

    cwd = Path(cwd_override) if cwd_override else Path.cwd()
    if not cwd.exists() or not cwd.is_dir():
        click.echo(f"error: cwd not found: {cwd}", err=True)
        sys.exit(2)

    # Restore the chdir + sys.path posture the user would have had.
    os.chdir(str(cwd))
    sys.path.insert(0, str(cwd))

    ap = (cwd / alembic_ini) if not Path(alembic_ini).is_absolute() else Path(alembic_ini)
    alembic_path = str(ap.resolve()) if ap.exists() else None

    # Lazy-import so the server's path doesn't pay this cost.
    from .inspectors.alembic import get_current_revision, list_migrations
    from .inspectors.database import inspect_database
    from .inspectors.sqlalchemy import inspect_models

    try:
        if models:
            schema_obj = inspect_models(models)
        else:
            schema_obj = inspect_database(db_url, schema=schema)  # type: ignore[arg-type]
    except ModuleNotFoundError as exc:
        if as_json:
            click.echo(json.dumps({"ok": False, "error": f"missing dependency: {exc.name}", "missing": exc.name}))
        else:
            _print_module_not_found_help(exc.name or "<unknown>", models or "")
        sys.exit(1)
    except Exception as exc:  # noqa: BLE001
        if as_json:
            click.echo(json.dumps({"ok": False, "error": str(exc)}))
        else:
            click.echo(f"error: {exc}", err=True)
        sys.exit(1)

    migrations = []
    current_rev = None
    if alembic_path:
        try:
            migrations = list_migrations(alembic_path, db_url=db_url)
        except Exception:
            migrations = []
    if db_url and alembic_path:
        try:
            current_rev = get_current_revision(db_url)
            schema_obj.current_revision = current_rev
        except Exception:
            pass

    store = CacheStore()
    project = project_root(cwd)
    git = git_context(cwd)
    target = models if models else safe_url(to_sync_url(db_url))  # type: ignore[arg-type]

    entry_id = store.upsert_entry(
        project_path=project,
        source_type="models" if models else "database",
        source_target=target,
        source_env=env,
        git=git,
        schema=schema_obj,
        migrations=migrations,
        current_revision=current_rev,
    )

    if as_json:
        click.echo(json.dumps({
            "ok": True,
            "entry_id": entry_id,
            "project_path": str(project),
            "table_count": len(schema_obj.tables),
            "migration_count": len(migrations),
        }))
    else:
        click.echo(f"cached @{entry_id} ({len(schema_obj.tables)} tables) → {cache_path()}")


# ─── Cache subcommands ──────────────────────────────────────────────────────


@main.group()
def cache() -> None:
    """Inspect and manage the local cache."""


@cache.command("path")
def cache_path_cmd() -> None:
    """Print the SQLite cache file path."""
    click.echo(str(cache_path()))


@cache.command("list")
@click.option("--all", "all_projects", is_flag=True, help="List across all projects")
def cache_list(all_projects: bool) -> None:
    """List cached entries."""
    store = CacheStore()
    projects = store.list_projects()
    cwd = Path.cwd().resolve()

    if not projects:
        click.echo("(no projects in cache yet — run `schema-viewer studio` to populate)")
        return

    rows: list[dict] = []
    for p in projects:
        if not all_projects and Path(p["path"]).resolve() != cwd:
            continue
        for e in store.list_entries(p["id"]):
            rows.append({**e, "project_path": p["path"], "project_name": p["name"]})

    if not rows:
        if all_projects:
            click.echo("(cache is empty)")
        else:
            click.echo(
                f"(no cached entries for {cwd} — pass --all to list other projects)"
            )
        return

    click.echo(f"{'ID':<5} {'PROJECT':<24} {'LANE':<22} {'BRANCH':<14} {'TABLES':>6}  {'FETCHED'}")
    click.echo("-" * 90)
    for r in rows:
        lane = f"{r['source_type']}{('·' + r['source_env']) if r['source_env'] else ''}"
        click.echo(
            f"@{r['id']:<4} {r['project_name'][:24]:<24} "
            f"{lane[:22]:<22} {(r['branch'] or '(n/a)')[:14]:<14} "
            f"{r['table_count']:>6}  {r['fetched_at']}"
        )


@cache.command("clear")
@click.option("--all", "all_projects", is_flag=True, help="Clear ALL projects")
@click.confirmation_option(prompt="Are you sure?")
def cache_clear(all_projects: bool) -> None:
    """Clear cached entries for the current project (or all)."""
    store = CacheStore()
    if all_projects:
        store.clear_all()
        click.echo("cache cleared")
    else:
        n = store.delete_project(Path.cwd())
        click.echo(f"removed {n} project(s) from cache")


@cache.command("forget")
@click.argument("project_path", type=click.Path(exists=False, path_type=Path))
def cache_forget(project_path: Path) -> None:
    """Remove a project (by path) from the cache."""
    store = CacheStore()
    n = store.delete_project(project_path)
    click.echo(f"removed {n} project(s)")


if __name__ == "__main__":
    main()
