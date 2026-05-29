from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, Query
from sqlalchemy.orm import Session

from compute import get_engine, INSTANCE_TYPES, DOCKER_NETWORK
from config import PUBLIC_HOST
from database import SessionLocal, get_db
from deps import get_current_user
from errors import (
    not_found,
    forbidden,
    bad_request,
    not_ready,
    quota_exceeded,
    conflict,
    raise_error,
)
from helpers import (
    allocate_ssh_port,
    build_volume_mounts,
    detach_all_volumes,
    get_attached_public_endpoint,
    get_default_network,
    get_default_security_group,
    get_public_endpoint_for_user,
    get_network_for_user,
    get_security_group_for_user,
    release_public_endpoints_for_instance,
    resolve_image_for_user,
    security_group_allows_port,
)
from models import (
    PublicEndpoint,
    Instance,
    InstanceStatus,
    Network,
    Snapshot,
    User,
    Volume,
    VolumeAttachment,
)
from schemas import ExecCommand, InstanceAction, InstanceCreate, InstanceTagsUpdate, SnapshotCreate

log = logging.getLogger("iaas.compute")
audit = logging.getLogger("iaas.audit")

router = APIRouter(tags=["Compute"])


def _serialize_tags(tags: dict | None) -> str | None:
    if not tags:
        return None
    return json.dumps(tags)


def _parse_tags(raw: str | None) -> dict:
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return {}


@router.get("/instances")
def list_instances(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    q = db.query(Instance)
    if not user.is_admin:
        q = q.filter(Instance.owner_id == user.id)
    instances = q.all()
    inst_ids = [i.id for i in instances]
    ep_map = {}
    if inst_ids:
        eps = db.query(PublicEndpoint).filter(PublicEndpoint.instance_id.in_(inst_ids)).all()
        ep_map = {e.instance_id: e for e in eps}
    return {"instances": [
        {"id": i.id, "name": i.name, "status": i.status,
         "status_detail": i.status_detail,
         "error_message": i.error_message if i.status == InstanceStatus.ERROR else None,
         "image": i.image, "instance_type": i.instance_type,
         "ip_address": i.ip_address, "ssh_port": i.ssh_port,
         "network_id": i.network_id,
         "security_group_id": i.security_group_id,
         "public_endpoint": f"{PUBLIC_HOST}:{ep_map[i.id].public_port}" if i.id in ep_map else None,
         "tags": _parse_tags(i.tags),
         "created_at": str(i.created_at)}
        for i in instances
    ]}


@router.post("/instances", status_code=201)
def create_instance(body: InstanceCreate, bg: BackgroundTasks,
                    user: User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    # Cek kuota
    active = db.query(Instance).filter(
        Instance.owner_id == user.id,
        Instance.status.in_(["pending", "running", "stopped"])
    ).count()
    if active >= user.quota_instances:
        quota_exceeded(active, user.quota_instances)

    image_key = resolve_image_for_user(db, user, body.image)
    if body.instance_type not in INSTANCE_TYPES:
        bad_request(f"Tipe tidak ada. Pilihan: {list(INSTANCE_TYPES.keys())}")

    itype = INSTANCE_TYPES[body.instance_type]
    iid   = str(uuid.uuid4())

    if body.network_id:
        network = get_network_for_user(db, user, body.network_id)
    else:
        network = get_default_network(db, user.id)

    if body.security_group_id:
        sg = get_security_group_for_user(db, user, body.security_group_id)
    else:
        sg = get_default_security_group(db, user.id)
    allow_ssh = security_group_allows_port(db, sg.id, 22)

    volume_ids = list(dict.fromkeys(body.volume_ids or []))
    volumes = []
    for vid in volume_ids:
        vol = db.query(Volume).filter(Volume.id == vid).first()
        if not vol:
            not_found(f"Volume {vid[:8]}")
        if not user.is_admin and vol.owner_id != user.id:
            forbidden()
        if vol.status != "available":
            conflict(f"Volume sedang terpasang: {vid[:8]}")
        volumes.append(vol)

    if body.public_endpoint_id and not allow_ssh:
        conflict("Security group menolak akses SSH")

    ssh_port = None
    ep = None
    if allow_ssh:
        if body.public_endpoint_id:
            ep = get_public_endpoint_for_user(db, user, body.public_endpoint_id)
            if ep.instance_id:
                conflict("Public endpoint sudah terpasang")
            if ep.status != "available":
                conflict("Public endpoint tidak tersedia")
            ssh_port = ep.public_port
        else:
            ssh_port = allocate_ssh_port(db)

    inst = Instance(
        id=iid, name=body.name, owner_id=user.id,
        owner_username=user.username, image=image_key,
        instance_type=body.instance_type,
        vcpu=itype["vcpu"], memory_mb=itype["memory_mb"],
        status=InstanceStatus.PENDING,
        status_detail="Queued for provisioning",
        network_id=network.id if network else None,
        security_group_id=sg.id if sg else None,
        ssh_port=ssh_port,
        tags=_serialize_tags(body.tags),
    )
    db.add(inst)
    if ep:
        ep.instance_id = iid
        ep.status = "attached"
    for vol in volumes:
        mount_path = f"/mnt/vol-{vol.id}"
        db.add(VolumeAttachment(
            id=str(uuid.uuid4()),
            volume_id=vol.id,
            instance_id=iid,
            mount_path=mount_path,
        ))
        vol.status = "in-use"
    db.commit()

    bg.add_task(
        _create_container,
        iid,
        body.name,
        image_key,
        itype,
        user.id,
        network.id if network else None,
        ssh_port,
        itype.get("gpu", False),
    )
    audit.info("INSTANCE_CREATE user=%s instance=%s name=%s type=%s",
               user.username, iid[:8], body.name, body.instance_type)
    return {
        "message": "Instance sedang dibuat",
        "instance_id": iid,
        "status": "pending",
        "status_detail": "Queued for provisioning",
    }


def _update_status_detail(iid: str, detail: str):
    """Update provisioning status detail in the database."""
    db = SessionLocal()
    try:
        inst = db.query(Instance).filter(Instance.id == iid).first()
        if inst:
            inst.status_detail = detail
            db.commit()
    except Exception:
        pass
    finally:
        db.close()


def _create_container(iid, name, image_key, itype, owner_id, network_id, ssh_port, gpu=False):
    db = SessionLocal()
    try:
        # Update status: starting provisioning
        inst = db.query(Instance).filter(Instance.id == iid).first()
        if inst:
            inst.status_detail = "Starting provisioning..."
            db.commit()

        network = None
        if network_id:
            network = db.query(Network).filter(Network.id == network_id).first()
        if not network:
            network = get_default_network(db, owner_id)

        volume_mounts = build_volume_mounts(db, iid)

        def status_callback(stage: str):
            _update_status_detail(iid, stage)

        result = get_engine().create_instance(
            name=name, image_key=image_key,
            vcpu=itype["vcpu"], memory_mb=itype["memory_mb"],
            owner_id=owner_id,
            instance_id=iid,
            network_name=network.docker_name if network else DOCKER_NETWORK,
            volume_mounts=volume_mounts,
            ssh_port=ssh_port,
            status_callback=status_callback,
            gpu=gpu,
        )
        # Reload instance to get fresh state
        inst = db.query(Instance).filter(Instance.id == iid).first()
        inst.container_id = result["container_id"]
        inst.ip_address   = result["ip_address"]
        inst.ssh_port     = result["ssh_port"]
        inst.ssh_password = result.get("ssh_password", "")
        inst.status       = InstanceStatus.RUNNING
        inst.status_detail = "Running"
        inst.error_message = None
        inst.updated_at   = datetime.utcnow()
        db.commit()
        log.info(f"Instance {iid[:8]} running — SSH port {result['ssh_port']}")
    except Exception as e:
        inst = db.query(Instance).filter(Instance.id == iid).first()
        if inst:
            inst.status = InstanceStatus.ERROR
            inst.status_detail = "Provisioning failed"
            inst.error_message = str(e)[:500]
        detach_all_volumes(db, iid)
        release_public_endpoints_for_instance(db, iid)
        db.commit()
        log.error(f"Gagal buat instance {iid[:8]}: {e}")
    finally:
        db.close()


@router.get("/instances/{iid}")
def get_instance(iid: str, user: User = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    inst = db.query(Instance).filter(Instance.id == iid).first()
    if not inst:
        not_found("Instance")
    if inst.owner_id != user.id and not user.is_admin:
        forbidden()
    ep = get_attached_public_endpoint(db, inst.id)
    return {
        "id": inst.id, "name": inst.name, "status": inst.status,
        "status_detail": inst.status_detail,
        "error_message": inst.error_message if inst.status == InstanceStatus.ERROR else None,
        "image": inst.image, "instance_type": inst.instance_type,
        "vcpu": inst.vcpu, "memory_mb": inst.memory_mb,
        "ip_address": inst.ip_address, "ssh_port": inst.ssh_port,
        "network_id": inst.network_id,
        "security_group_id": inst.security_group_id,
        "public_endpoint": f"{PUBLIC_HOST}:{ep.public_port}" if ep else None,
        "ssh_command": f"ssh root@{PUBLIC_HOST} -p {inst.ssh_port}" if inst.ssh_port else None,
        "ssh_password": inst.ssh_password,
        "tags": _parse_tags(inst.tags),
        "created_at": str(inst.created_at),
    }


@router.get("/instances/{iid}/status")
def instance_status(iid: str, user: User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    inst = db.query(Instance).filter(Instance.id == iid).first()
    if not inst:
        not_found("Instance")
    if inst.owner_id != user.id and not user.is_admin:
        forbidden()
    if not inst.container_id:
        not_ready("Container")
    return get_engine().get_status(inst.container_id)


@router.get("/instances/{iid}/logs")
def instance_logs(iid: str,
                  tail: int = Query(default=100, ge=1, le=1000),
                  user: User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    """Retrieve container stdout/stderr logs."""
    inst = db.query(Instance).filter(Instance.id == iid).first()
    if not inst:
        not_found("Instance")
    if inst.owner_id != user.id and not user.is_admin:
        forbidden()
    if not inst.container_id:
        not_ready("Container")
    logs = get_engine().get_container_logs(inst.container_id, tail=tail)
    return {"instance_id": iid, "logs": logs}


@router.patch("/instances/{iid}/tags")
def update_tags(iid: str, body: InstanceTagsUpdate,
                user: User = Depends(get_current_user),
                db: Session = Depends(get_db)):
    """Update instance tags (key-value metadata)."""
    inst = db.query(Instance).filter(Instance.id == iid).first()
    if not inst:
        not_found("Instance")
    if inst.owner_id != user.id and not user.is_admin:
        forbidden()
    inst.tags = _serialize_tags(body.tags)
    inst.updated_at = datetime.utcnow()
    db.commit()
    return {"message": "Tags updated", "tags": body.tags}


@router.post("/instances/{iid}/action")
def instance_action(iid: str, body: InstanceAction,
                    user: User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    inst = db.query(Instance).filter(Instance.id == iid).first()
    if not inst:
        not_found("Instance")
    if inst.owner_id != user.id and not user.is_admin:
        forbidden()
    if not inst.container_id:
        not_ready("Container")

    eng    = get_engine()
    action = body.action.lower()

    if action == "start":
        eng.start_instance(inst.container_id)
        inst.status = InstanceStatus.RUNNING
        inst.status_detail = "Running"
    elif action == "stop":
        eng.stop_instance(inst.container_id)
        inst.status = InstanceStatus.STOPPED
        inst.status_detail = "Stopped by user"
    elif action == "reboot":
        eng.restart_instance(inst.container_id)
        inst.status = InstanceStatus.RUNNING
        inst.status_detail = "Running (rebooted)"
    elif action == "terminate":
        eng.terminate_instance(inst.container_id)
        inst.status = InstanceStatus.TERMINATED
        inst.status_detail = "Terminated"
        detach_all_volumes(db, inst.id)
        release_public_endpoints_for_instance(db, inst.id)
        inst.ssh_port = None
    else:
        bad_request(f"Action tidak dikenal: {action}")

    inst.updated_at = datetime.utcnow()
    db.commit()
    audit.info("INSTANCE_%s user=%s instance=%s",
               action.upper(), user.username, iid[:8])
    return {"message": f"Action '{action}' berhasil", "status": inst.status, "status_detail": inst.status_detail}


@router.post("/instances/{iid}/exec")
def exec_command(iid: str, body: ExecCommand,
                 user: User = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    inst = db.query(Instance).filter(Instance.id == iid).first()
    if not inst or not inst.container_id:
        not_found("Instance atau container belum siap")
    if inst.owner_id != user.id and not user.is_admin:
        forbidden()
    return get_engine().exec_command(inst.container_id, body.command)


@router.post("/instances/{iid}/snapshot", status_code=201)
def create_snapshot(iid: str, body: SnapshotCreate,
                    user: User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    inst = db.query(Instance).filter(Instance.id == iid).first()
    if not inst or not inst.container_id:
        not_found("Instance atau container belum siap")
    if inst.owner_id != user.id and not user.is_admin:
        forbidden()

    name = body.name or f"snap-{iid[:8]}-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}"
    existing = db.query(Snapshot).filter(
        Snapshot.owner_id == user.id,
        Snapshot.name == name,
    ).first()
    if existing:
        conflict("Nama snapshot sudah dipakai")

    snap_id = str(uuid.uuid4())
    image_repo = f"iaas-snap-{snap_id}"
    try:
        result = get_engine().create_snapshot(inst.container_id, image_repo, tag="latest")
    except Exception as e:
        raise_error(500, "SNAPSHOT_FAILED", f"Gagal membuat snapshot: {e}")

    snap = Snapshot(
        id=snap_id,
        name=name,
        owner_id=inst.owner_id,
        source_instance_id=inst.id,
        image_ref=result["image_ref"],
    )
    db.add(snap)
    db.commit()
    return {"snapshot_id": snap.id, "name": snap.name, "image_ref": snap.image_ref}


@router.get("/snapshots")
def list_snapshots(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    q = db.query(Snapshot)
    if not user.is_admin:
        q = q.filter(Snapshot.owner_id == user.id)
    snaps = q.order_by(Snapshot.created_at.desc()).all()
    return {
        "snapshots": [
            {
                "id": s.id,
                "name": s.name,
                "source_instance_id": s.source_instance_id,
                "image_ref": s.image_ref,
                "created_at": str(s.created_at),
            }
            for s in snaps
        ]
    }


@router.delete("/snapshots/{sid}")
def delete_snapshot(sid: str, user: User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    snap = db.query(Snapshot).filter(Snapshot.id == sid).first()
    if not snap:
        not_found("Snapshot")
    if not user.is_admin and snap.owner_id != user.id:
        forbidden()
    in_use = db.query(Instance).filter(
        Instance.image == snap.image_ref,
        Instance.status != InstanceStatus.TERMINATED,
    ).count()
    if in_use > 0:
        conflict("Snapshot masih dipakai instance")
    try:
        get_engine().remove_image(snap.image_ref)
    except Exception as e:
        conflict(f"Gagal menghapus image: {e}")
    db.delete(snap)
    db.commit()
    return {"message": "Snapshot dihapus"}
