from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from cache import cache_get, cache_set
from compute import get_engine, AVAILABLE_IMAGES, INSTANCE_TYPES
from database import get_db
from deps import get_current_user, require_admin
from models import Instance, User

router = APIRouter()


@router.get("/monitoring/host", tags=["Monitoring"])
def host_metrics(admin: User = Depends(require_admin)):
    cached = cache_get("monitoring:host")
    if cached:
        return cached
    data = get_engine().get_host_info()
    cache_set("monitoring:host", data, ttl=5)
    return data


@router.get("/monitoring/summary", tags=["Monitoring"])
def summary(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if user.is_admin:
        running = db.query(Instance).filter(Instance.status == "running").count()
        stopped = db.query(Instance).filter(Instance.status == "stopped").count()
        total = db.query(Instance).count()
        users = db.query(User).count()
        return {
            "scope": "global",
            "instances": {"running": running, "stopped": stopped, "total": total},
            "users": users,
        }

    running = db.query(Instance).filter(
        Instance.owner_id == user.id,
        Instance.status == "running",
    ).count()
    stopped = db.query(Instance).filter(
        Instance.owner_id == user.id,
        Instance.status == "stopped",
    ).count()
    total = db.query(Instance).filter(
        Instance.owner_id == user.id,
        Instance.status.in_(["pending", "running", "stopped", "error"]),
    ).count()
    return {
        "scope": "self",
        "instances": {"running": running, "stopped": stopped, "total": total},
        "users": None,
    }


# ── Catalog & Health ──────────────────────────────────────────
@router.get("/catalog/images", tags=["Catalog"])
def list_images():
    return {"images": list(AVAILABLE_IMAGES.keys())}


@router.get("/catalog/instance-types", tags=["Catalog"])
def list_types():
    return {"instance_types": INSTANCE_TYPES}


@router.get("/health", tags=["System"])
def health():
    return {"status": "ok", "service": "Miniatur IaaS", "time": datetime.utcnow().isoformat()}


@router.get("/", tags=["System"])
def root():
    return {"message": "Miniatur IaaS API", "docs": "/docs", "health": "/health"}
