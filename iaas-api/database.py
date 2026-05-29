from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker
from models import Base
from config import DATABASE_URL

_is_sqlite = DATABASE_URL.startswith("sqlite")

_connect_args = {}
if _is_sqlite:
    _connect_args["check_same_thread"] = False

engine = create_engine(DATABASE_URL, connect_args=_connect_args)
SessionLocal = sessionmaker(bind=engine)


def _table_has_column(inspector, table_name: str, column_name: str) -> bool:
    columns = [c["name"] for c in inspector.get_columns(table_name)]
    return column_name in columns


def _ensure_column(conn, inspector, table_name: str, column_name: str, column_type: str):
    if not _table_has_column(inspector, table_name, column_name):
        conn.execute(text(
            f'ALTER TABLE {table_name} ADD COLUMN {column_name} {column_type}'
        ))
        conn.commit()


def ensure_schema():
    Base.metadata.create_all(engine)
    insp = inspect(engine)
    with engine.connect() as conn:
        # Instance model extensions
        if insp.has_table("instances"):
            _ensure_column(conn, insp, "instances", "network_id", "VARCHAR(36)")
            _ensure_column(conn, insp, "instances", "security_group_id", "VARCHAR(36)")
            _ensure_column(conn, insp, "instances", "status_detail", "VARCHAR(256)")
            _ensure_column(conn, insp, "instances", "error_message", "TEXT")
            _ensure_column(conn, insp, "instances", "tags", "TEXT")


ensure_schema()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
