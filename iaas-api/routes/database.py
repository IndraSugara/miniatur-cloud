"""Routes for RDS managed database service.

Each database is a separate PostgreSQL container on the user's network.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from database import get_db
from deps import get_current_user
from errors import (
    bad_request,
    forbidden,
    not_found,
    not_ready,
    quota_exceeded,
)
from config import PUBLIC_DOMAIN, RDS_PORT_START, RDS_PORT_END
from helpers import (
    ensure_gateway_connected_to_network,
    get_default_network,
    get_network_for_user,
)
from models import (
    DatabaseInstance,
    DatabaseStatus,
    Network,
    User,
)
from rds_engine import (
    _generate_db_identifier,
    _generate_password,
    create_rds_container,
    delete_rds_container,
    get_container_ip,
    restart_rds_container,
    start_rds_container,
    stop_rds_container,
    update_rds_password,
    wait_for_ready,
    add_port_mapping,
    remove_port_mapping,
)
from schemas import DatabaseAction, DatabaseCreate

router = APIRouter(tags=["Database (RDS)"])
log = logging.getLogger("iaas.rds.routes")
audit = logging.getLogger("iaas.audit")

MAX_DATABASES_PER_USER = 3


# ── Helpers ──────────────────────────────────────────────────

def _get_db_for_user(db: Session, user: User, db_id: str) -> DatabaseInstance:
    rds = db.query(DatabaseInstance).filter(DatabaseInstance.id == db_id).first()
    if not rds:
        not_found("Database")
    if not user.is_admin and rds.owner_id != user.id:
        forbidden()
    return rds


def _build_connection_string(rds: DatabaseInstance, async_driver: bool = False) -> str:
    driver = "postgresql+asyncpg" if async_driver else "postgresql"
    host = rds.ip_address or "pending"
    return f"{driver}://{rds.db_user}:{rds.db_password}@{host}:{rds.port}/{rds.db_name}"


def _serialize(rds: DatabaseInstance) -> dict:
    return {
        "id": rds.id,
        "name": rds.name,
        "engine": rds.engine,
        "status": rds.status.value if isinstance(rds.status, DatabaseStatus) else rds.status,
        "db_name": rds.db_name,
        "db_user": rds.db_user,
        "db_password": rds.db_password,
        "ip_address": rds.ip_address,
        "port": rds.port,
        "network_id": rds.network_id,
        "connection_string": _build_connection_string(rds),
        "connection_string_async": _build_connection_string(rds, async_driver=True),
        "public_hostname": rds.public_hostname,
        "public_url": f"postgresql://{rds.db_user}:{rds.db_password}@{rds.public_hostname}:{rds.expose_port}/{rds.db_name}"
                      if rds.public_hostname and rds.expose_port else None,
        "expose_port": rds.expose_port,
        "error_message": rds.error_message,
        "created_at": str(rds.created_at),
        "updated_at": str(rds.updated_at),
    }


def _allocate_rds_port(db: Session) -> int:
    """Allocate a host port for public RDS access."""
    used = set(
        p[0] for p in db.query(DatabaseInstance.expose_port)
        .filter(DatabaseInstance.expose_port.isnot(None))
        .all()
    )
    for port in range(RDS_PORT_START, RDS_PORT_END + 1):
        if port not in used:
            return port
    bad_request("Port pool untuk RDS publik habis")


# ── Routes ───────────────────────────────────────────────────

@router.get("/databases")
def list_databases(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    q = db.query(DatabaseInstance).filter(
        DatabaseInstance.status != DatabaseStatus.DELETING,
    )
    if not user.is_admin:
        q = q.filter(DatabaseInstance.owner_id == user.id)
    databases = q.order_by(DatabaseInstance.created_at.desc()).all()
    return {"databases": [_serialize(d) for d in databases]}


@router.post("/databases", status_code=201)
def create_database(
    body: DatabaseCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # Quota check
    count = db.query(DatabaseInstance).filter(
        DatabaseInstance.owner_id == user.id,
        DatabaseInstance.status.notin_([DatabaseStatus.DELETING, DatabaseStatus.ERROR]),
    ).count()
    if count >= MAX_DATABASES_PER_USER:
        quota_exceeded(count, MAX_DATABASES_PER_USER)

    # Resolve network
    if body.network_id:
        network = get_network_for_user(db, user, body.network_id)
    else:
        network = get_default_network(db, user.id)

    # Generate identifiers
    db_id = str(uuid.uuid4())
    db_identifier = _generate_db_identifier(db_id)
    password = _generate_password()

    # Create DB record
    rds = DatabaseInstance(
        id=db_id,
        name=body.name,
        owner_id=user.id,
        owner_username=user.username,
        engine=body.engine,
        status=DatabaseStatus.CREATING,
        db_name=db_identifier,
        db_user=db_identifier,
        db_password=password,
        network_id=network.id,
        port=5432,
    )
    db.add(rds)
    db.commit()

    # Create the container
    try:
        result = create_rds_container(
            db_id=db_id,
            db_name=db_identifier,
            db_user=db_identifier,
            db_password=password,
            owner_id=user.id,
            network_name=network.docker_name,
        )
        rds.container_id = result["container_id"]
        rds.ip_address = result["ip_address"]
        rds.volume_name = result["volume_name"]
        db.commit()

        # Wait for PostgreSQL to be ready
        ready = wait_for_ready(result["container_id"], timeout=30)
        if ready:
            rds.status = DatabaseStatus.AVAILABLE
        else:
            rds.status = DatabaseStatus.ERROR
            rds.error_message = "PostgreSQL tidak siap setelah 30 detik"
        rds.updated_at = datetime.now(timezone.utc)
        db.commit()

    except Exception as e:
        log.error(f"Failed to create RDS container: {e}")
        rds.status = DatabaseStatus.ERROR
        rds.error_message = str(e)[:500]
        rds.updated_at = datetime.now(timezone.utc)
        db.commit()

    audit.info("RDS_CREATE user=%s db=%s status=%s", user.username, db_id[:8], rds.status.value)
    return _serialize(rds)


@router.get("/databases/{db_id}")
def get_database(
    db_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rds = _get_db_for_user(db, user, db_id)
    return _serialize(rds)


@router.delete("/databases/{db_id}")
def delete_database(
    db_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rds = _get_db_for_user(db, user, db_id)

    rds.status = DatabaseStatus.DELETING
    rds.updated_at = datetime.now(timezone.utc)
    db.commit()

    # Remove public exposure if any
    if rds.public_hostname:
        rds.public_hostname = None
        rds.expose_port = None

    # Destroy container + volume
    if rds.container_id:
        try:
            delete_rds_container(rds.container_id, rds.volume_name)
        except Exception as e:
            log.warning(f"Error deleting RDS container: {e}")

    db.delete(rds)
    db.commit()
    audit.info("RDS_DELETE user=%s db=%s", user.username, db_id[:8])
    return {"message": "Database dihapus"}


@router.post("/databases/{db_id}/action")
def database_action(
    db_id: str,
    body: DatabaseAction,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rds = _get_db_for_user(db, user, db_id)
    action = body.action.lower()

    if not rds.container_id:
        not_ready("Database")

    # Resolve network docker_name for IP lookup
    net_docker_name = None
    if rds.network_id:
        net = db.query(Network).filter(Network.id == rds.network_id).first()
        if net:
            net_docker_name = net.docker_name

    if action == "stop":
        if rds.status != DatabaseStatus.AVAILABLE:
            bad_request("Database tidak dalam status available")
        stop_rds_container(rds.container_id)
        rds.status = DatabaseStatus.STOPPED

    elif action == "start":
        if rds.status != DatabaseStatus.STOPPED:
            bad_request("Database tidak dalam status stopped")
        ip = start_rds_container(rds.container_id, net_docker_name or "bridge")
        rds.ip_address = ip
        rds.status = DatabaseStatus.AVAILABLE

    elif action == "reboot":
        if rds.status != DatabaseStatus.AVAILABLE:
            bad_request("Database tidak dalam status available")
        ip = restart_rds_container(rds.container_id, net_docker_name or "bridge")
        rds.ip_address = ip

    else:
        bad_request(f"Action tidak dikenal: {action}")

    rds.updated_at = datetime.now(timezone.utc)
    db.commit()
    audit.info("RDS_%s user=%s db=%s", action.upper(), user.username, db_id[:8])
    return _serialize(rds)


@router.post("/databases/{db_id}/reset-password")
def reset_password(
    db_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rds = _get_db_for_user(db, user, db_id)

    if rds.status != DatabaseStatus.AVAILABLE:
        not_ready("Database harus dalam status available")

    if not rds.container_id:
        not_ready("Database")

    new_password = _generate_password()
    success = update_rds_password(rds.container_id, rds.db_user, new_password)
    if not success:
        bad_request("Gagal mengubah password. Coba lagi.")

    rds.db_password = new_password
    rds.updated_at = datetime.now(timezone.utc)
    db.commit()

    audit.info("RDS_RESET_PASSWORD user=%s db=%s", user.username, db_id[:8])
    return _serialize(rds)


@router.post("/databases/{db_id}/expose")
def expose_database(
    db_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rds = _get_db_for_user(db, user, db_id)

    if rds.status != DatabaseStatus.AVAILABLE:
        not_ready("Database harus dalam status available")

    if rds.public_hostname:
        bad_request("Database sudah di-expose")

    if not rds.container_id:
        not_ready("Database")

    # Allocate a host port
    host_port = _allocate_rds_port(db)

    # Recreate container with port mapping
    try:
        new_container_id = add_port_mapping(rds.container_id, host_port)
        rds.container_id = new_container_id
    except Exception as e:
        log.error(f"Failed to expose RDS: {e}")
        bad_request(f"Gagal expose database: {str(e)[:200]}")

    # Wait for PostgreSQL to recover
    wait_for_ready(rds.container_id, timeout=20)

    # Update IP
    if rds.network_id:
        net = db.query(Network).filter(Network.id == rds.network_id).first()
        if net:
            ip = get_container_ip(rds.container_id, net.docker_name)
            if ip:
                rds.ip_address = ip

    # Set hostname
    hostname = f"db-{rds.db_name}-{db_id[:8]}.{PUBLIC_DOMAIN}"
    rds.public_hostname = hostname
    rds.expose_port = host_port
    rds.updated_at = datetime.now(timezone.utc)
    db.commit()

    audit.info("RDS_EXPOSE user=%s db=%s port=%d", user.username, db_id[:8], host_port)
    return _serialize(rds)


@router.delete("/databases/{db_id}/expose")
def unexpose_database(
    db_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rds = _get_db_for_user(db, user, db_id)

    if not rds.public_hostname:
        bad_request("Database tidak sedang di-expose")

    if not rds.container_id:
        not_ready("Database")

    # Recreate container without port mapping
    try:
        new_container_id = remove_port_mapping(rds.container_id)
        rds.container_id = new_container_id
    except Exception as e:
        log.error(f"Failed to unexpose RDS: {e}")
        bad_request(f"Gagal unexpose database: {str(e)[:200]}")

    # Wait for PostgreSQL to recover
    wait_for_ready(rds.container_id, timeout=20)

    # Update IP
    if rds.network_id:
        net = db.query(Network).filter(Network.id == rds.network_id).first()
        if net:
            ip = get_container_ip(rds.container_id, net.docker_name)
            if ip:
                rds.ip_address = ip

    rds.public_hostname = None
    rds.expose_port = None
    rds.updated_at = datetime.now(timezone.utc)
    db.commit()

    audit.info("RDS_UNEXPOSE user=%s db=%s", user.username, db_id[:8])
    return _serialize(rds)
