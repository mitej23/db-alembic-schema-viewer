import os
import sys
import webbrowser
from pathlib import Path

import click
import uvicorn

from .inspectors.database import safe_url, to_sync_url
from .server import Settings, create_app


def _running_under_pipx() -> bool:
    """Detect whether schema-viewer is installed in a pipx-managed venv."""
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
    click.echo(
        "    in schema-viewer's environment.",
        err=True,
    )
    click.echo("", err=True)

    # Headline fix — separate line, nothing else around it, easy to copy.
    click.secho("  ▸ run this, then re-run schema-viewer:", bold=True, err=True)
    click.echo("", err=True)
    click.secho(f"      {fix_cmd}", fg="cyan", bold=True, err=True)
    click.echo("", err=True)

    # Alternatives in plain text.
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


@click.group()
@click.version_option()
def main() -> None:
    """schema-viewer — read-only schema visualizer for SQLAlchemy/Alembic projects."""


@main.command()
@click.option(
    "--models",
    "-m",
    help=(
        "Python target for SQLAlchemy models. Two forms: "
        "'pkg.module:Base' (explicit) or 'pkg' (walks the package, imports every "
        "submodule, and merges metadata from every Base it finds)."
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
@click.option("--host", default="127.0.0.1", show_default=True)
@click.option("--port", "-p", default=5555, type=int, show_default=True)
@click.option("--no-browser", is_flag=True, help="Don't open the browser automatically")
def studio(
    models: str | None,
    db_url: str | None,
    alembic_ini: str,
    schema: str | None,
    host: str,
    port: int,
    no_browser: bool,
) -> None:
    """Launch the schema viewer studio in the browser."""
    if not models and not db_url:
        click.echo(
            "error: provide --models or --db-url (or set DATABASE_URL)",
            err=True,
        )
        sys.exit(2)

    if models:
        # so `--models myapp.db.models:Base` resolves from cwd
        sys.path.insert(0, os.getcwd())

    alembic_path: str | None = None
    ap = Path(alembic_ini)
    if ap.exists():
        alembic_path = str(ap.resolve())
    elif alembic_ini != "alembic.ini":
        click.echo(f"error: alembic.ini not found at {alembic_ini}", err=True)
        sys.exit(2)

    settings = Settings(
        models=models,
        db_url=db_url,
        alembic_ini=alembic_path,
        schema=schema,
    )
    app = create_app(settings)

    # Eagerly probe the data source so misconfiguration fails on the CLI,
    # not in the browser network tab.
    if models:
        try:
            from .inspectors.sqlalchemy import inspect_models
            inspect_models(models)
        except ModuleNotFoundError as exc:
            _print_module_not_found_help(exc.name or "<unknown>", models)
            sys.exit(1)
        except Exception as exc:
            click.secho(f"\n  error loading models {models!r}: {exc}", fg="red", err=True)
            click.echo(
                "  hint: schema-viewer accepts either 'pkg.module:Base' or just 'pkg' "
                "(walks the package and merges all bases).",
                err=True,
            )
            sys.exit(1)

    url = f"http://{host}:{port}"
    click.secho("\n  schema-viewer", fg="cyan", bold=True, nl=False)
    click.echo(f"  →  {url}")
    if models:
        click.echo(f"  source:  models  ({models})")
    else:
        click.echo(f"  source:  database  ({safe_url(to_sync_url(db_url))})")  # type: ignore[arg-type]
    if alembic_path:
        click.echo(f"  alembic: {alembic_path}")
    else:
        click.echo("  alembic: (none — pass --alembic-ini to enable migrations panel)")
    click.echo()

    if not no_browser:
        webbrowser.open(url)

    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
