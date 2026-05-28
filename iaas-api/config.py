
import logging
import os
import re
import secrets

_raw_secret = os.getenv("SECRET_KEY", "")
_PLACEHOLDERS = {"", "iaas-jetson-secret-ganti-ini", "iaas-jetson-rahasia-ganti-ini"}
if _raw_secret in _PLACEHOLDERS:
    SECRET_KEY = secrets.token_urlsafe(48)
    logging.getLogger("iaas.config").warning(
        "SECRET_KEY belum di-set atau masih placeholder — menggunakan random key. "
        "Set SECRET_KEY di environment untuk JWT yang persisten antar restart."
    )
else:
    SECRET_KEY = _raw_secret
ALGORITHM    = "HS256"
TOKEN_EXPIRE = 60
DB_URL       = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./iaas.db")
DB_SYNC_URL  = DB_URL.replace("aiosqlite", "pysqlite").replace("+aiosqlite", "")

MINIO_ENDPOINT   = os.getenv("MINIO_ENDPOINT", "cloud-storage:9000")
MINIO_ACCESS_KEY = os.getenv("MINIO_ACCESS_KEY", "admin")
MINIO_SECRET_KEY = os.getenv("MINIO_SECRET_KEY", "CloudPass2024!")
MINIO_SECURE     = os.getenv("MINIO_SECURE", "false").lower() in ("1", "true", "yes")
BUCKET_NAME_RE   = re.compile(r"^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$")

PUBLIC_HOST      = os.getenv("PUBLIC_HOST", "192.168.1.2")
FLOATING_PORT_START = int(os.getenv("FLOATING_PORT_START", "2300"))
FLOATING_PORT_END   = int(os.getenv("FLOATING_PORT_END", "2399"))
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
