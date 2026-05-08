import importlib
import pkgutil
import sys
from datetime import datetime, timezone
from typing import Iterable, Literal, Optional

from sqlalchemy import MetaData
from sqlalchemy.sql.schema import Table as SATable

from ..models import Column, ForeignKey, Index, Schema, Table

# Submodule names that commonly fail to import in third-party projects and
# aren't expected to register tables. Skipped during package-walk discovery.
_SKIP_SUBMODULE_FRAGMENTS = ("tests", "test_", "_test", "conftest", "migrations")


def _resolve_explicit(target: str) -> MetaData:
    """Resolve 'module.path:attr' to a MetaData object."""
    module_path, attr = target.rsplit(":", 1)
    module = importlib.import_module(module_path)
    obj = getattr(module, attr)
    if isinstance(obj, MetaData):
        return obj
    metadata = getattr(obj, "metadata", None)
    if isinstance(metadata, MetaData):
        return metadata
    raise TypeError(
        f"{target!r} resolved to {type(obj).__name__}; "
        "expected sqlalchemy.MetaData or a declarative Base."
    )


def _walk_and_import(package_name: str) -> tuple[list[str], list[tuple[str, Exception]]]:
    """Import every submodule of a package. Returns (imported, errors)."""
    pkg = importlib.import_module(package_name)
    imported = [package_name]
    errors: list[tuple[str, Exception]] = []
    if not hasattr(pkg, "__path__"):
        return imported, errors

    for _finder, name, _ispkg in pkgutil.walk_packages(
        pkg.__path__, prefix=pkg.__name__ + "."
    ):
        if any(frag in name.split(".") for frag in _SKIP_SUBMODULE_FRAGMENTS):
            continue
        try:
            importlib.import_module(name)
            imported.append(name)
        except Exception as e:  # noqa: BLE001 — collect & continue
            errors.append((name, e))
    return imported, errors


def _collect_metadata_from_modules(module_names: Iterable[str]) -> list[MetaData]:
    """Scan the given modules' globals for MetaData instances (deduped by id)."""
    seen: set[int] = set()
    found: list[MetaData] = []
    for name in module_names:
        mod = sys.modules.get(name)
        if mod is None:
            continue
        for attr in dir(mod):
            try:
                obj = getattr(mod, attr)
            except Exception:
                continue
            md: Optional[MetaData] = None
            if isinstance(obj, MetaData):
                md = obj
            else:
                inner = getattr(obj, "metadata", None)
                if isinstance(inner, MetaData):
                    md = inner
            if md is not None and id(md) not in seen and md.tables:
                seen.add(id(md))
                found.append(md)
    return found


def _merge_metadata(metas: list[MetaData]) -> MetaData:
    if len(metas) == 1:
        return metas[0]
    combined = MetaData()
    seen_names: set[tuple[Optional[str], str]] = set()
    for md in metas:
        for table in md.tables.values():
            key = (table.schema, table.name)
            if key in seen_names:
                continue
            seen_names.add(key)
            try:
                table.to_metadata(combined)
            except Exception:
                # If a table can't be cleanly cloned, skip it rather than fail.
                pass
    return combined


def discover_metadata(package_name: str) -> MetaData:
    """Walk a package, import every submodule, and union all SQLAlchemy MetaData found.

    Use this when you don't know exactly where the project's `Base` lives, or when
    models are scattered across many files that aren't imported from `__init__.py`.
    """
    imported, errors = _walk_and_import(package_name)
    relevant = [m for m in imported if m == package_name or m.startswith(package_name + ".")]
    metas = _collect_metadata_from_modules(relevant)

    if not metas:
        hint = ""
        if errors:
            sample = ", ".join(f"{n} ({type(e).__name__})" for n, e in errors[:3])
            hint = (
                f"\nSome submodules failed to import (first 3): {sample}. "
                "If those define your models, fix the imports or pass an explicit "
                "module:Base target."
            )
        raise ValueError(
            f"No SQLAlchemy MetaData with tables found under {package_name!r}.{hint}"
        )
    return _merge_metadata(metas)


def load_metadata(target: str) -> MetaData:
    """Resolve a target string to a MetaData object.

    Two forms supported:
      * 'pkg.module:attr' — explicit Base/MetaData attribute (fastest, deterministic)
      * 'pkg' or 'pkg.module' — walk the package, import every submodule, and
        merge metadata from every Base found. Use when models are scattered.
    """
    if ":" in target:
        return _resolve_explicit(target)
    return discover_metadata(target)


def _column_default(col) -> Optional[str]:
    if col.default is not None:
        arg = getattr(col.default, "arg", None)
        if arg is not None:
            return repr(arg) if not isinstance(arg, str) else arg
        return repr(col.default)
    if col.server_default is not None:
        arg = getattr(col.server_default, "arg", None)
        if arg is not None:
            return str(arg)
        return str(col.server_default)
    return None


def _table_to_model(sa_table: SATable) -> Table:
    cols: list[Column] = []
    for col in sa_table.columns:
        autoinc = col.autoincrement
        cols.append(
            Column(
                name=col.name,
                type=str(col.type),
                nullable=bool(col.nullable),
                primary_key=bool(col.primary_key),
                unique=bool(col.unique) if col.unique is not None else False,
                default=_column_default(col),
                comment=col.comment,
                autoincrement=bool(autoinc) if autoinc is not True else bool(col.primary_key),
            )
        )

    fks: list[ForeignKey] = []
    for fk in sa_table.foreign_keys:
        fks.append(
            ForeignKey(
                column=fk.parent.name,
                references_table=fk.column.table.name,
                references_column=fk.column.name,
                references_schema=fk.column.table.schema,
                on_delete=fk.ondelete,
                on_update=fk.onupdate,
                name=fk.name,
            )
        )

    idxs: list[Index] = []
    for idx in sa_table.indexes:
        idxs.append(
            Index(
                name=idx.name or "",
                columns=[c.name for c in idx.columns],
                unique=bool(idx.unique),
            )
        )

    return Table(
        name=sa_table.name,
        schema=sa_table.schema,
        columns=cols,
        foreign_keys=fks,
        indexes=idxs,
        comment=sa_table.comment,
    )


def metadata_to_schema(
    metadata: MetaData, source: Literal["models", "database"] = "models"
) -> Schema:
    tables = [_table_to_model(t) for t in metadata.sorted_tables]
    return Schema(
        tables=tables,
        source=source,
        generated_at=datetime.now(timezone.utc).isoformat(),
    )


def inspect_models(target: str) -> Schema:
    metadata = load_metadata(target)
    return metadata_to_schema(metadata, source="models")
