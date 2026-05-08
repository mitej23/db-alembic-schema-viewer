from typing import Optional

from sqlalchemy import MetaData, create_engine
from sqlalchemy.engine.url import make_url

from ..models import Schema
from .sqlalchemy import metadata_to_schema

# Drivers that only support async I/O — we swap them for SQLAlchemy's default
# sync driver for the backend (e.g. psycopg2 for postgresql) when reflecting.
ASYNC_ONLY_DRIVERS = {"asyncpg", "aiomysql", "asyncmy", "aiosqlite"}


def to_sync_url(url: str) -> str:
    """Normalize an async SQLAlchemy URL to its sync equivalent.

    Examples:
        postgresql+asyncpg://...  → postgresql://...   (uses psycopg2)
        mysql+aiomysql://...      → mysql://...        (uses pymysql)
        sqlite+aiosqlite://...    → sqlite://...
        postgresql+psycopg2://... → unchanged
    """
    u = make_url(url)
    parts = u.drivername.split("+", 1)
    if len(parts) == 2 and parts[1] in ASYNC_ONLY_DRIVERS:
        u = u.set(drivername=parts[0])
    return str(u)


def safe_url(url: str) -> str:
    """Return the URL with the password redacted, suitable for logs/UI."""
    u = make_url(url)
    if u.password:
        u = u.set(password="***")
    return str(u)


def inspect_database(url: str, schema: Optional[str] = None) -> Schema:
    """Reflect a live database into the schema model. Read-only."""
    sync_url = to_sync_url(url)
    engine = create_engine(sync_url)
    try:
        md = MetaData(schema=schema)
        md.reflect(bind=engine, views=False)
        result = metadata_to_schema(md, source="database")
        result.database_url_safe = safe_url(sync_url)
        return result
    finally:
        engine.dispose()
