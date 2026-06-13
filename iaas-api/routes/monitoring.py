from __future__ import annotations

import time as time_module
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from cache import cache_get, cache_set
from compute import get_engine, AVAILABLE_IMAGES, INSTANCE_TYPES
from database import get_db
from deps import get_current_user, require_admin
from errors import forbidden, not_found
from models import Instance, User
from monitoring_service import (
    _instance_cpu_query,
    _instance_mem_query,
    _instance_net_rx_query,
    _instance_net_tx_query,
    _instance_disk_query,
    _build_loki_query,
    query_prometheus,
    query_loki,
    get_instant_metric,
    get_range_metric,
)

router = APIRouter()


def _verify_instance_owner(db: Session, iid: str, user: User) -> Instance:
    """Return the instance if it exists and belongs to the user (or user is admin)."""
    inst = db.query(Instance).filter(Instance.id == iid).first()
    if not inst:
        not_found("Instance")
    if inst.owner_id != user.id and not user.is_admin:
        forbidden()
    return inst


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
        total = db.query(Instance).filter(
            Instance.status.in_(["pending", "running", "stopped", "error"])
        ).count()
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


# ── User-Facing Instance Metrics ──────────────────────────────

@router.get("/monitoring/instances/{iid}/metrics", tags=["User Monitoring"])
async def instance_metrics(
    iid: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Live CPU, memory, network, disk for a user's instance (from Prometheus/cAdvisor)."""
    inst = _verify_instance_owner(db, iid, user)
    if inst.status.value != "running":
        return {"instance_id": iid, "status": inst.status.value, "metrics": None}

    owner_id = user.id
    cpu_val = await get_instant_metric(_instance_cpu_query(owner_id, iid))
    mem_bytes = await get_instant_metric(_instance_mem_query(owner_id, iid))
    net_rx = await get_instant_metric(_instance_net_rx_query(owner_id, iid))
    net_tx = await get_instant_metric(_instance_net_tx_query(owner_id, iid))
    disk_bytes = await get_instant_metric(_instance_disk_query(owner_id, iid))

    return {
        "instance_id": iid,
        "status": "running",
        "metrics": {
            "cpu_percent": round(cpu_val, 2) if cpu_val is not None else None,
            "memory_mb": round(mem_bytes / 1024 / 1024, 1) if mem_bytes else None,
            "memory_usage_bytes": mem_bytes,
            "network_rx_bytes_sec": round(net_rx, 2) if net_rx else None,
            "network_tx_bytes_sec": round(net_tx, 2) if net_tx else None,
            "disk_usage_bytes": disk_bytes,
        },
    }


@router.get("/monitoring/instances/{iid}/metrics/range", tags=["User Monitoring"])
async def instance_metrics_range(
    iid: str,
    start: str = Query(default="now-1h", description="Start time (Prometheus format, e.g. now-1h)"),
    end: str = Query(default="now", description="End time (Prometheus format)"),
    step: str = Query(default="15s", description="Resolution step"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Historical time-series CPU, memory, network for a user's instance."""
    inst = _verify_instance_owner(db, iid, user)
    owner_id = user.id

    cpu_data = await get_range_metric(
        _instance_cpu_query(owner_id, iid), start, end, step
    )
    mem_data = await get_range_metric(
        _instance_mem_query(owner_id, iid), start, end, step
    )
    net_rx_data = await get_range_metric(
        _instance_net_rx_query(owner_id, iid), start, end, step
    )
    net_tx_data = await get_range_metric(
        _instance_net_tx_query(owner_id, iid), start, end, step
    )

    return {
        "instance_id": iid,
        "start": start,
        "end": end,
        "step": step,
        "cpu_percent": [{"t": int(float(ts)), "v": float(val)} for ts, val in cpu_data],
        "memory_mb": [
            {"t": int(float(ts)), "v": round(float(val) / 1024 / 1024, 1)}
            for ts, val in mem_data
        ],
        "network_rx_bytes_sec": [
            {"t": int(float(ts)), "v": float(val)} for ts, val in net_rx_data
        ],
        "network_tx_bytes_sec": [
            {"t": int(float(ts)), "v": float(val)} for ts, val in net_tx_data
        ],
    }


@router.get("/monitoring/instances/{iid}/logs", tags=["User Monitoring"])
async def instance_logs(
    iid: str,
    since: Optional[str] = Query(default=None, description="ISO 8601 start (default 1h ago)"),
    until: Optional[str] = Query(default=None, description="ISO 8601 end (default now)"),
    search: Optional[str] = Query(default=None, description="Search string in log content"),
    limit: int = Query(default=100, ge=1, le=1000),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Search logs via Loki for a user's instance."""
    inst = _verify_instance_owner(db, iid, user)
    owner_id = user.id

    # Default time range: last 1 hour
    now_ns = time_module.time_ns()
    default_start = now_ns - 3600 * 1_000_000_000
    start_ns = default_start
    end_ns = now_ns

    # Parse ISO 8601 strings if provided
    if since:
        try:
            start_ns = int(datetime.fromisoformat(since).timestamp() * 1_000_000_000)
        except (ValueError, TypeError):
            pass
    if until:
        try:
            end_ns = int(datetime.fromisoformat(until).timestamp() * 1_000_000_000)
        except (ValueError, TypeError):
            pass

    logql = _build_loki_query(owner_id, iid, search=search)
    result = await query_loki(logql, start_ns, end_ns, limit=limit)

    streams = result.get("data", {}).get("result", [])
    entries = []
    for stream in streams:
        for val in stream.get("values", []):
            entries.append({
                "timestamp_ns": val[0],
                "line": val[1],
            })

    entries.sort(key=lambda e: e["timestamp_ns"], reverse=True)
    return {
        "instance_id": iid,
        "limit": limit,
        "entries": entries[:limit],
    }


# ── Catalog & Health ──────────────────────────────────────────
@router.get("/catalog/images", tags=["Catalog"])
def list_images():
    """Return image catalog with descriptions."""
    return {
        "images": [
            {"key": key, "description": entry["description"]}
            for key, entry in AVAILABLE_IMAGES.items()
        ]
    }


@router.get("/catalog/instance-types", tags=["Catalog"])
def list_types():
    """Return instance types with specs and descriptions."""
    return {
        "instance_types": {
            key: {
                "vcpu": val["vcpu"],
                "memory_mb": val["memory_mb"],
                "gpu": val.get("gpu", False),
                "description": val["description"],
            }
            for key, val in INSTANCE_TYPES.items()
        }
    }


@router.get("/health", tags=["System"])
def health():
    return {"status": "ok", "service": "Miniatur IaaS", "time": datetime.now(timezone.utc).isoformat()}


@router.get("/api-info", tags=["System"])
def api_info():
    """API information and useful links."""
    return {
        "service": "Miniatur IaaS API",
        "version": "1.1.0",
        "docs_url": "/api/docs",
        "health_url": "/api/health",
        "changes": [
            "Bilingual error responses (code + message)",
            "Refresh token support",
            "Instance provisioning stages & error details",
            "Container logs endpoint",
            "Instance tags (key-value metadata)",
            "Public Endpoints (formerly Floating IPs)",
            "State-preserving volume/security-group changes",
            "Enhanced catalog with descriptions",
        ],
    }


@router.get("/", tags=["System"])
def root():
    return {"message": "Miniatur IaaS API", "docs": "/docs", "health": "/health"}
