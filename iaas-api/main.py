from __future__ import annotations

import logging
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import SECRET_KEY  # noqa: F401 – ensure config loads
from database import SessionLocal
from deps import hash_password
from helpers import ensure_default_network, ensure_default_security_group
from models import User

from routes.auth import router as auth_router
from routes.compute import router as compute_router
from routes.network import router as network_router
from routes.storage import router as storage_router
from routes.monitoring import router as monitoring_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
log = logging.getLogger("iaas.api")


# ── Lifespan ──────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(application: FastAPI):
    # ── startup ──
    db = SessionLocal()
    admin = db.query(User).filter(User.username == "admin").first()
    if not admin:
        admin = User(
            id=str(uuid.uuid4()),
            username="admin",
            email="admin@iaas.local",
            hashed_password=hash_password("admin123"),
            is_admin=True,
            quota_instances=10,
        )
        db.add(admin)
        db.commit()
        log.info("Admin default dibuat: admin / admin123")

    try:
        ensure_default_network(db, admin.id)
        ensure_default_security_group(db, admin.id)
    except Exception as e:
        log.error(f"Gagal memastikan default network/sg: {e}")
    db.close()
    log.info("Miniatur IaaS API ready")

    yield  # ── app is running ──

    # ── shutdown ──
    log.info("Miniatur IaaS API shutting down")


# ── App ───────────────────────────────────────────────────────
app = FastAPI(
    title="Miniatur IaaS API",
    description="Infrastructure as a Service — Jetson Nano",
    version="1.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)

# ── Register routers ─────────────────────────────────────────
app.include_router(auth_router)
app.include_router(compute_router)
app.include_router(network_router)
app.include_router(storage_router)
app.include_router(monitoring_router)
