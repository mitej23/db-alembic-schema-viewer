"""SQLite-backed cache for schema fetches.

Stores at most one row per (project, lane, branch). Fresh fetches in the same
lane on the same branch update the existing row in place — this is a cache,
not a version-control history.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, Optional

from .models import Migration, Schema


def cache_path() -> Path:
    """Return the SQLite cache path. Honors XDG_DATA_HOME on macOS/Linux."""
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / "schema-viewer" / "cache.db"


_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS projects (
  id           INTEGER PRIMARY KEY,
  path         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  id                INTEGER PRIMARY KEY,
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_type       TEXT NOT NULL,
  source_target     TEXT NOT NULL,
  source_env        TEXT NOT NULL DEFAULT '',
  branch            TEXT NOT NULL DEFAULT '',
  commit_sha        TEXT,
  is_dirty          INTEGER NOT NULL DEFAULT 0,
  schema_json       TEXT NOT NULL,
  migrations_json   TEXT,
  current_revision  TEXT,
  table_count       INTEGER NOT NULL,
  content_hash      TEXT NOT NULL,
  fetched_at        TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lane_branch
  ON entries(project_id, source_type, source_target, source_env, branch);

CREATE INDEX IF NOT EXISTS idx_project_time
  ON entries(project_id, fetched_at DESC);
"""

_LOCK = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


@dataclass
class GitContext:
    branch: Optional[str] = None
    commit_sha: Optional[str] = None
    is_dirty: bool = False


@dataclass
class CacheEntry:
    id: int
    project_id: int
    project_path: str
    project_name: str
    source_type: str           # 'models' | 'database'
    source_target: str
    source_env: Optional[str]
    branch: Optional[str]
    commit_sha: Optional[str]
    is_dirty: bool
    schema: dict               # parsed Schema JSON
    migrations: list           # parsed Migration[] (or [])
    current_revision: Optional[str]
    table_count: int
    content_hash: str
    fetched_at: str


def _none_if_empty(s: Optional[str]) -> Optional[str]:
    return s if s else None


class CacheStore:
    def __init__(self, path: Optional[Path] = None) -> None:
        self.path = path or cache_path()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init()

    def _init(self) -> None:
        with self._connect() as conn:
            conn.executescript(_SCHEMA_SQL)

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(str(self.path), timeout=10.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    # ── Projects ─────────────────────────────────────────────────────────

    def upsert_project(self, path: Path) -> int:
        path = path.resolve()
        with _LOCK, self._connect() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO projects(path, name, created_at) VALUES(?,?,?)",
                (str(path), path.name, _now()),
            )
            row = conn.execute(
                "SELECT id FROM projects WHERE path = ?", (str(path),)
            ).fetchone()
            return int(row["id"])

    def list_projects(self) -> list[dict]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT
                  p.id, p.path, p.name, p.created_at,
                  COUNT(e.id)                                      AS entry_count,
                  MAX(e.fetched_at)                                AS last_fetched_at,
                  COUNT(DISTINCT NULLIF(e.branch, ''))             AS branch_count,
                  COUNT(DISTINCT e.source_type)                    AS lane_count,
                  COALESCE(MAX(e.table_count), 0)                  AS max_table_count
                FROM projects p
                LEFT JOIN entries e ON e.project_id = p.id
                GROUP BY p.id
                ORDER BY (last_fetched_at IS NULL), last_fetched_at DESC
                """
            ).fetchall()
        return [dict(r) for r in rows]

    def delete_project(self, path: Path) -> int:
        with _LOCK, self._connect() as conn:
            cur = conn.execute(
                "DELETE FROM projects WHERE path = ?",
                (str(path.resolve()),),
            )
            return cur.rowcount

    # ── Entries ──────────────────────────────────────────────────────────

    def upsert_entry(
        self,
        project_path: Path,
        source_type: str,
        source_target: str,
        source_env: Optional[str],
        git: GitContext,
        schema: Schema,
        migrations: list[Migration],
        current_revision: Optional[str],
    ) -> int:
        proj_id = self.upsert_project(project_path)
        schema_json = schema.model_dump_json()
        migrations_json = (
            json.dumps([m.model_dump() for m in migrations]) if migrations else None
        )
        content = _hash(schema_json + (migrations_json or ""))
        env = source_env or ""
        branch = git.branch or ""

        with _LOCK, self._connect() as conn:
            cur = conn.execute(
                """
                INSERT INTO entries(
                  project_id, source_type, source_target, source_env, branch, commit_sha,
                  is_dirty, schema_json, migrations_json, current_revision,
                  table_count, content_hash, fetched_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(project_id, source_type, source_target, source_env, branch)
                DO UPDATE SET
                  commit_sha=excluded.commit_sha,
                  is_dirty=excluded.is_dirty,
                  schema_json=excluded.schema_json,
                  migrations_json=excluded.migrations_json,
                  current_revision=excluded.current_revision,
                  table_count=excluded.table_count,
                  content_hash=excluded.content_hash,
                  fetched_at=excluded.fetched_at
                RETURNING id
                """,
                (
                    proj_id, source_type, source_target, env, branch, git.commit_sha,
                    int(git.is_dirty), schema_json, migrations_json, current_revision,
                    len(schema.tables), content, _now(),
                ),
            )
            return int(cur.fetchone()["id"])

    def list_entries(self, project_id: int) -> list[dict]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, project_id, source_type, source_target, source_env,
                       branch, commit_sha, is_dirty, current_revision,
                       table_count, content_hash, fetched_at
                FROM entries
                WHERE project_id = ?
                ORDER BY fetched_at DESC
                """,
                (project_id,),
            ).fetchall()
        return [self._normalize_summary(dict(r)) for r in rows]

    def get_entry(self, entry_id: int) -> Optional[CacheEntry]:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT e.*, p.path AS project_path, p.name AS project_name
                FROM entries e
                JOIN projects p ON p.id = e.project_id
                WHERE e.id = ?
                """,
                (entry_id,),
            ).fetchone()
        if not row:
            return None
        return CacheEntry(
            id=row["id"],
            project_id=row["project_id"],
            project_path=row["project_path"],
            project_name=row["project_name"],
            source_type=row["source_type"],
            source_target=row["source_target"],
            source_env=_none_if_empty(row["source_env"]),
            branch=_none_if_empty(row["branch"]),
            commit_sha=row["commit_sha"],
            is_dirty=bool(row["is_dirty"]),
            schema=json.loads(row["schema_json"]),
            migrations=(
                json.loads(row["migrations_json"]) if row["migrations_json"] else []
            ),
            current_revision=row["current_revision"],
            table_count=row["table_count"],
            content_hash=row["content_hash"],
            fetched_at=row["fetched_at"],
        )

    def find_latest(
        self,
        project_path: Path,
        source_type: Optional[str] = None,
        source_target: Optional[str] = None,
        source_env: Optional[str] = None,
        branch: Optional[str] = None,
    ) -> Optional[CacheEntry]:
        """Find latest matching entry. None values mean 'don't filter'."""
        sql = (
            "SELECT e.id FROM entries e "
            "JOIN projects p ON p.id = e.project_id "
            "WHERE p.path = ?"
        )
        params: list = [str(project_path.resolve())]
        if source_type is not None:
            sql += " AND e.source_type = ?"
            params.append(source_type)
        if source_target is not None:
            sql += " AND e.source_target = ?"
            params.append(source_target)
        if source_env is not None:
            sql += " AND e.source_env = ?"
            params.append(source_env or "")
        if branch is not None:
            sql += " AND e.branch = ?"
            params.append(branch or "")
        sql += " ORDER BY e.fetched_at DESC LIMIT 1"

        with self._connect() as conn:
            row = conn.execute(sql, params).fetchone()
        if not row:
            return None
        return self.get_entry(int(row["id"]))

    def delete_entry(self, entry_id: int) -> int:
        with _LOCK, self._connect() as conn:
            cur = conn.execute("DELETE FROM entries WHERE id = ?", (entry_id,))
            return cur.rowcount

    def clear_all(self) -> None:
        with _LOCK, self._connect() as conn:
            conn.execute("DELETE FROM entries")
            conn.execute("DELETE FROM projects")

    # ── helpers ──────────────────────────────────────────────────────────

    @staticmethod
    def _normalize_summary(row: dict) -> dict:
        row["source_env"] = _none_if_empty(row.get("source_env"))
        row["branch"] = _none_if_empty(row.get("branch"))
        row["is_dirty"] = bool(row.get("is_dirty"))
        return row
