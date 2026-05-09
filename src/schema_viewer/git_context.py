"""Git context capture — branch, commit SHA, dirty flag, project root.

Tolerant of missing git, non-repo cwds, and detached HEAD. Never raises;
returns sane defaults instead.
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Optional

from .cache import GitContext

_TIMEOUT = 5.0


def _run(args: list[str], cwd: Path) -> Optional[str]:
    try:
        result = subprocess.run(
            args,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=_TIMEOUT,
            check=False,
        )
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def project_root(cwd: Path) -> Path:
    """Return the git toplevel for cwd if available, else cwd itself."""
    cwd = cwd.resolve()
    top = _run(["git", "rev-parse", "--show-toplevel"], cwd=cwd)
    if top:
        return Path(top).resolve()
    return cwd


def git_context(cwd: Path) -> GitContext:
    cwd = cwd.resolve()
    inside = _run(["git", "rev-parse", "--is-inside-work-tree"], cwd=cwd)
    if inside != "true":
        return GitContext()
    branch = _run(["git", "symbolic-ref", "--short", "HEAD"], cwd=cwd)  # None on detached
    sha = _run(["git", "rev-parse", "HEAD"], cwd=cwd)
    status = _run(["git", "status", "--porcelain"], cwd=cwd)
    return GitContext(
        branch=branch,
        commit_sha=sha,
        is_dirty=bool(status),
    )
