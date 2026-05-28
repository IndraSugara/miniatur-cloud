from __future__ import annotations

import logging
import uuid
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy.orm import Session

from compute import get_engine, INSTANCE_TYPES, DOCKER_NETWORK
from config import PUBLIC_HOST
from database import SessionLocal, get_db
from deps import get_current_user
from helpers import (
    allocate_ssh_port,
    build_volume_mounts,
    detach_all_volumes,
    get_attached_floating_ip,
    get_default_network,
    get_default_security_group,
    get_floating_ip_for_user,
    get_network_for_user,
    get_security_group_for_user,
    release_floating_ips_for_instance,
    resolve_image_for_user,
    security_group_allows_port,
)
from models import (
    FloatingIP,
    Instance,
    InstanceStatus,
    Network,
    Snapshot,
    User,
    Volume,
    VolumeAttachment,
)
from schemas import ExecCommand, InstanceAction, InstanceCreate, SnapshotCreate

log = logging.getLogger("iaas.compute")
audit = logging.getLogger("iaas.audit")

router = APIRouter(tags=["Compute"])


@router.get("/instances")
def list_instances(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    q = db.query(Instance)
    if not user.is_admin:
        q = q.filter(Instance.owner_id == user.id)
    instances = q.all()
    inst_ids = [i.id for i in instances]
    fip_map = {}
    if inst_ids:
        fips = db.query(FloatingIP).filter(FloatingIP.instance_id.in_(inst_ids)).all()
        fip_map = {f.instance_id: f for f in fips}
    return {"instances": [
        {"id": i.id, "name": i.name, "status": i.status,
         "image": i.image, "instance_type": i.instance_type,
         "ip_address": i.ip_address, "ssh_port": i.ssh_port,
         "network_id": i.network_id,
         "security_group_id": i.security_group_id,
         "floating_ip": f"{PUBLIC_HOST}:{fip_map[i.id].public_port}" if i.id in fip_map else None,
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
        raise HTTPException(429, f"Kuota instance habis ({user.quota_instances} max)")

    image_key = resolve_image_for_user(db, user, body.image)
    if body.instance_type not in INSTANCE_TYPES:
        raise HTTPException(400, f"Tipe tidak ada. Pilihan: {list(INSTANCE_TYPES.keys())}")

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
            raise HTTPException(404, f"Volume tidak ditemukan: {vid}")
        if not user.is_admin and vol.owner_id != user.id:
            raise HTTPException(403, "Bukan milikmu")
        if vol.status != "available":
            raise HTTPException(409, f"Volume sedang terpasang: {vid}")
        volumes.append(vol)

    if body.floating_ip_id and not allow_ssh:
        raise HTTPException(409, "Security group menolak akses SSH")

    ssh_port = None
    fip = None
    if allow_ssh:
        if body.floating_ip_id:
            fip = get_floating_ip_for_user(db, user, body.floating_ip_id)
            if fip.instance_id:
                raise HTTPException(409, "Floating IP sudah terpasang")
            if fip.status != "available":
                raise HTTPException(409, "Floating IP tidak tersedia")
            ssh_port = fip.public_port
        else:
            ssh_port = allocate_ssh_port(db)

    inst = Instance(
        id=iid, name=body.name, owner_id=user.id,
        owner_username=user.username, image=image_key,
        instance_type=body.instance_type,
        vcpu=itype["vcpu"], memory_mb=itype["memory_mb"],
        status=InstanceStatus.PENDING,
        network_id=network.id if network else None,
        security_group_id=sg.id if sg else None,
        ssh_port=ssh_port,
    )
    db.add(inst)
    if fip:
        fip.instance_id = iid
        fip.status = "attached"
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
    )
    audit.info("INSTANCE_CREATE user=%s instance=%s name=%s type=%s",
               user.username, iid[:8], body.name, body.instance_type)
    return {"message": "Instance sedang dibuat", "instance_id": iid, "status": "pending"}


def _create_container(iid, name, image_key, itype, owner_id, network_id, ssh_port):
    db = SessionLocal()
    try:
        network = None
        if network_id:
            network = db.query(Network).filter(Network.id == network_id).first()
        if not network:
            network = get_default_network(db, owner_id)

        volume_mounts = build_volume_mounts(db, iid)
        result = get_engine().create_instance(
            name=name, image_key=image_key,
            vcpu=itype["vcpu"], memory_mb=itype["memory_mb"],
            owner_id=owner_id,
            instance_id=iid,
            network_name=network.docker_name if network else DOCKER_NETWORK,
            volume_mounts=volume_mounts,
            ssh_port=ssh_port,
        )
        inst = db.query(Instance).filter(Instance.id == iid).first()
        inst.container_id = result["container_id"]
        inst.ip_address   = result["ip_address"]
        inst.ssh_port     = result["ssh_port"]
        inst.ssh_password = result.get("ssh_password", "")
        inst.status       = InstanceStatus.RUNNING
        inst.updated_at   = datetime.utcnow()
        db.commit()
        log.info(f"Instance {iid[:8]} running — SSH port {result['ssh_port']}")
    except Exception as e:
        inst = db.query(Instance).filter(Instance.id == iid).first()
        if inst:
            inst.status = InstanceStatus.ERROR
        detach_all_volumes(db, iid)
        release_floating_ips_for_instance(db, iid)
        db.commit()
        log.error(f"Gagal buat instance {iid[:8]}: {e}")
    finally:
        db.close()


@router.get("/instances/{iid}")
def get_instance(iid: str, user: User = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    inst = db.query(Instance).filter(Instance.id == iid).first()
    if not inst:
        raise HTTPException(404, "Instance tidak ditemukan")
    if inst.owner_id != user.id and not user.is_admin:
        raise HTTPException(403, "Bukan milikmu")
    fip = get_attached_floating_ip(db, inst.id)
    return {"id": inst.id, "name": inst.name, "status": inst.status,
            "image": inst.image, "instance_type": inst.instance_type,
            "vcpu": inst.vcpu, "memory_mb": inst.memory_mb,
            "ip_address": inst.ip_address, "ssh_port": inst.ssh_port,
            "network_id": inst.network_id,
            "security_group_id": inst.security_group_id,
            "floating_ip": f"{PUBLIC_HOST}:{fip.public_port}" if fip else None,
            "ssh_command": f"ssh root@{PUBLIC_HOST} -p {inst.ssh_port}" if inst.ssh_port else None,
            "ssh_password": inst.ssh_password,
            "created_at": str(inst.created_at)}


@router.get("/instances/{iid}/status")
def instance_status(iid: str, user: User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    inst = db.query(Instance).filter(Instance.id == iid).first()
    if not inst:
        raise HTTPException(404, "Instance tidak ditemukan")
    if inst.owner_id != user.id and not user.is_admin:
        raise HTTPException(403, "Bukan milikmu")
    if not inst.container_id:
        raise HTTPException(400, "Container belum siap")
    return get_engine().get_status(inst.container_id)


@router.post("/instances/{iid}/action")
def instance_action(iid: str, body: InstanceAction,
                    user: User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    inst = db.query(Instance).filter(Instance.id == iid).first()
    if not inst:
        raise HTTPException(404, "Instance tidak ditemukan")
    if inst.owner_id != user.id and not user.is_admin:
        raise HTTPException(403, "Bukan milikmu")
    if not inst.container_id:
        raise HTTPException(400, "Container belum siap")

    eng    = get_engine()
    action = body.action.lower()

    if action == "start":
        eng.start_instance(inst.container_id)
        inst.status = InstanceStatus.RUNNING
    elif action == "stop":
        eng.stop_instance(inst.container_id)
        inst.status = InstanceStatus.STOPPED
    elif action == "reboot":
        eng.restart_instance(inst.container_id)
        inst.status = InstanceStatus.RUNNING
    elif action == "terminate":
        eng.terminate_instance(inst.container_id)
        inst.status = InstanceStatus.TERMINATED
        detach_all_volumes(db, inst.id)
        release_floating_ips_for_instance(db, inst.id)
        inst.ssh_port = None
    else:
        raise HTTPException(400, f"Action tidak dikenal: {action}")

    inst.updated_at = datetime.utcnow()
    db.commit()
    audit.info("INSTANCE_%s user=%s instance=%s",
               action.upper(), user.username, iid[:8])
    return {"message": f"Action '{action}' berhasil", "status": inst.status}


@router.post("/instances/{iid}/exec")
def exec_command(iid: str, body: ExecCommand,
                 user: User = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    inst = db.query(Instance).filter(Instance.id == iid).first()
    if not inst or not inst.container_id:
        raise HTTPException(404, "Instance tidak ditemukan atau belum siap")
    if inst.owner_id != user.id and not user.is_admin:
        raise HTTPException(403, "Bukan milikmu")
    return get_engine().exec_command(inst.container_id, body.command)


@router.post("/instances/{iid}/snapshot", status_code=201)
def create_snapshot(iid: str, body: SnapshotCreate,
                    user: User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    inst = db.query(Instance).filter(Instance.id == iid).first()
    if not inst or not inst.container_id:
        raise HTTPException(404, "Instance tidak ditemukan atau belum siap")
    if inst.owner_id != user.id and not user.is_admin:
        raise HTTPException(403, "Bukan milikmu")

    name = body.name or f"snap-{iid[:8]}-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}"
    existing = db.query(Snapshot).filter(
        Snapshot.owner_id == user.id,
        Snapshot.name == name,
    ).first()
    if existing:
        raise HTTPException(409, "Nama snapshot sudah dipakai")

    snap_id = str(uuid.uuid4())
    image_repo = f"iaas-snap-{snap_id}"
    try:
        result = get_engine().create_snapshot(inst.container_id, image_repo, tag="latest")
    except Exception as e:
        raise HTTPException(500, f"Gagal membuat snapshot: {e}")

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
        raise HTTPException(404, "Snapshot tidak ditemukan")
    if not user.is_admin and snap.owner_id != user.id:
        raise HTTPException(403, "Bukan milikmu")
    in_use = db.query(Instance).filter(
        Instance.image == snap.image_ref,
        Instance.status != InstanceStatus.TERMINATED,
    ).count()
    if in_use > 0:
        raise HTTPException(409, "Snapshot masih dipakai instance")
    try:
        get_engine().remove_image(snap.image_ref)
    except Exception as e:
        raise HTTPException(409, f"Gagal menghapus image: {e}")
    db.delete(snap)
    db.commit()
    return {"message": "Snapshot dihapus"}
