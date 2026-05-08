from pathlib import Path
from typing import Optional, Union

from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine

from ..models import Migration
from .database import to_sync_url


def load_alembic_config(ini_path: Union[str, Path]) -> Config:
    return Config(str(ini_path))


def list_migrations(
    alembic_ini: Union[str, Path],
    db_url: Optional[str] = None,
) -> list[Migration]:
    """List all Alembic migrations on disk, newest first.

    If db_url is provided, also marks which migrations are applied to the DB.
    Database access is read-only — only `alembic_version` is queried.
    """
    cfg = load_alembic_config(alembic_ini)
    sync_db_url = to_sync_url(db_url) if db_url else None
    if sync_db_url:
        cfg.set_main_option("sqlalchemy.url", sync_db_url)
    script = ScriptDirectory.from_config(cfg)

    applied: set[str] = set()
    if sync_db_url:
        engine = create_engine(sync_db_url)
        try:
            with engine.connect() as conn:
                ctx = MigrationContext.configure(conn)
                heads = ctx.get_current_heads() or ()
                for head in heads:
                    for rev in script.iterate_revisions(head, "base"):
                        applied.add(rev.revision)
        except Exception:
            # Don't fail listing if DB is unreachable; just leave applied empty.
            pass
        finally:
            engine.dispose()

    head_revisions = set(script.get_heads())

    migrations: list[Migration] = []
    for rev in script.walk_revisions():
        down = rev.down_revision
        if isinstance(down, tuple):
            down = down[0] if down else None
        migrations.append(
            Migration(
                revision=rev.revision,
                down_revision=down,
                description=rev.doc,
                is_current_head=rev.revision in head_revisions,
                is_applied=rev.revision in applied,
                branch_labels=list(rev.branch_labels) if rev.branch_labels else [],
                file=rev.path,
            )
        )
    return migrations


def get_current_revision(db_url: str) -> Optional[str]:
    """Return the single current head from `alembic_version`, or None."""
    engine = create_engine(to_sync_url(db_url))
    try:
        with engine.connect() as conn:
            ctx = MigrationContext.configure(conn)
            return ctx.get_current_revision()
    except Exception:
        return None
    finally:
        engine.dispose()
