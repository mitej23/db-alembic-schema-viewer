from typing import Optional, Literal
from pydantic import BaseModel, ConfigDict, Field


class Column(BaseModel):
    name: str
    type: str
    nullable: bool = False
    primary_key: bool = False
    unique: bool = False
    default: Optional[str] = None
    comment: Optional[str] = None
    autoincrement: bool = False


class ForeignKey(BaseModel):
    column: str
    references_table: str
    references_column: str
    references_schema: Optional[str] = None
    on_delete: Optional[str] = None
    on_update: Optional[str] = None
    name: Optional[str] = None


class Index(BaseModel):
    name: str
    columns: list[str]
    unique: bool = False


class Table(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str
    schema_name: Optional[str] = Field(default=None, alias="schema")
    columns: list[Column]
    foreign_keys: list[ForeignKey] = []
    indexes: list[Index] = []
    comment: Optional[str] = None


class Migration(BaseModel):
    revision: str
    down_revision: Optional[str] = None
    description: Optional[str] = None
    is_current_head: bool = False
    is_applied: bool = False
    branch_labels: list[str] = []
    file: Optional[str] = None


class Schema(BaseModel):
    tables: list[Table]
    source: Literal["models", "database"]
    current_revision: Optional[str] = None
    database_url_safe: Optional[str] = None
    generated_at: str
