from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .inspectors.alembic import get_current_revision, list_migrations
from .inspectors.database import inspect_database, safe_url
from .inspectors.sqlalchemy import inspect_models
from .models import Migration, Schema

STATIC_DIR = Path(__file__).parent / "static"


@dataclass
class Settings:
    models: Optional[str] = None
    db_url: Optional[str] = None
    alembic_ini: Optional[str] = None
    schema: Optional[str] = None

    def __post_init__(self) -> None:
        if not self.models and not self.db_url:
            raise ValueError("Provide either `models` or `db_url`.")


def create_app(settings: Settings) -> FastAPI:
    app = FastAPI(
        title="Schema Viewer",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.get("/api/health")
    def health() -> dict:
        return {
            "ok": True,
            "source": "models" if settings.models else "database",
            "alembic": bool(settings.alembic_ini),
        }

    @app.get("/api/info")
    def info() -> dict:
        return {
            "source": "models" if settings.models else "database",
            "models": settings.models,
            "database_url": safe_url(settings.db_url) if settings.db_url else None,
            "alembic_ini": settings.alembic_ini,
            "schema": settings.schema,
        }

    @app.get("/api/schema", response_model=Schema)
    def get_schema() -> Schema:
        try:
            if settings.models:
                result = inspect_models(settings.models)
            else:
                assert settings.db_url is not None  # guarded by Settings
                result = inspect_database(settings.db_url, schema=settings.schema)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to inspect schema: {exc}") from exc

        if settings.db_url and settings.alembic_ini:
            result.current_revision = get_current_revision(settings.db_url)
        return result

    @app.get("/api/migrations", response_model=list[Migration])
    def get_migrations() -> list[Migration]:
        if not settings.alembic_ini:
            return []
        try:
            return list_migrations(settings.alembic_ini, db_url=settings.db_url)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to load migrations: {exc}") from exc

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

    if STATIC_DIR.exists():
        app.mount(
            "/static",
            StaticFiles(directory=STATIC_DIR),
            name="static",
        )

        @app.get("/")
        def root() -> FileResponse:
            index = STATIC_DIR / "index.html"
            if not index.exists():
                raise HTTPException(status_code=500, detail="index.html missing from package")
            return FileResponse(index)

    return app
