from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from models import Base
from config import DB_SYNC_URL

engine = create_engine(DB_SYNC_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine)


def _table_columns(conn, table_name: str):
    rows = conn.execute(text(f"PRAGMA table_info({table_name})")).fetchall()
    return {row[1] for row in rows}


def _ensure_column(conn, table_name: str, column_name: str, column_type: str):
    cols = _table_columns(conn, table_name)
    if column_name not in cols:
        conn.execute(text(
            f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_type}"
        ))


def ensure_schema():
    Base.metadata.create_all(engine)
    with engine.connect() as conn:
        _ensure_column(conn, "instances", "network_id", "VARCHAR(36)")
        _ensure_column(conn, "instances", "security_group_id", "VARCHAR(36)")


ensure_schema()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
