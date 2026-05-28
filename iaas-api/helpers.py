from __future__ import annotations

from datetime import datetime
from typing import Optional

import uuid
from fastapi import HTTPException
from minio import Minio
from sqlalchemy.orm import Session

from config import (
    BUCKET_NAME_RE,
    FLOATING_PORT_END,
    FLOATING_PORT_START,
    MINIO_ACCESS_KEY,
    MINIO_ENDPOINT,
    MINIO_SECRET_KEY,
    MINIO_SECURE,
)
from compute import get_engine, AVAILABLE_IMAGES, DOCKER_NETWORK
from models import (
    FloatingIP,
    Instance,
    InstanceStatus,
    Network,
    ObjectBucket,
    SecurityGroup,
    SecurityGroupRule,
    Snapshot,
    User,
    Volume,
    VolumeAttachment,
)


# ── Security Groups ────────────────────────────────────────────
def ensure_default_security_group(db: Session, owner_id: str) -> SecurityGroup:
    sg = db.query(SecurityGroup).filter(SecurityGroup.is_default == True).first()
    if sg:
        return sg
    sg = SecurityGroup(
        id=str(uuid.uuid4()),
        name="default",
        owner_id=owner_id,
        is_default=True,
    )
    db.add(sg)
    db.add(SecurityGroupRule(
        id=str(uuid.uuid4()),
        group_id=sg.id,
        direction="ingress",
        protocol="tcp",
        port_min=22,
        port_max=22,
        cidr="0.0.0.0/0",
    ))
    db.commit()
    return sg


def get_default_security_group(db: Session, owner_id: str) -> SecurityGroup:
    sg = db.query(SecurityGroup).filter(SecurityGroup.is_default == True).first()
    if not sg:
        sg = ensure_default_security_group(db, owner_id)
    return sg


def get_security_group_for_user(db: Session, user: User, sg_id: str) -> SecurityGroup:
    sg = db.query(SecurityGroup).filter(SecurityGroup.id == sg_id).first()
    if not sg:
        raise HTTPException(404, "Security group tidak ditemukan")
    if not user.is_admin and not sg.is_default and sg.owner_id != user.id:
        raise HTTPException(403, "Bukan milikmu")
    return sg


def security_group_allows_port(db: Session, sg_id: str, port: int) -> bool:
    rules = db.query(SecurityGroupRule).filter(
        SecurityGroupRule.group_id == sg_id,
        SecurityGroupRule.direction == "ingress",
        SecurityGroupRule.protocol == "tcp",
        SecurityGroupRule.port_min <= port,
        SecurityGroupRule.port_max >= port,
    ).count()
    return rules > 0


# ── Floating IPs ────────────────────────────────────────────────
def get_floating_ip_for_user(db: Session, user: User, fid: str) -> FloatingIP:
    fip = db.query(FloatingIP).filter(FloatingIP.id == fid).first()
    if not fip:
        raise HTTPException(404, "Floating IP tidak ditemukan")
    if not user.is_admin and fip.owner_id != user.id:
        raise HTTPException(403, "Bukan milikmu")
    return fip


def release_floating_ips_for_instance(db: Session, instance_id: str):
    fips = db.query(FloatingIP).filter(FloatingIP.instance_id == instance_id).all()
    for fip in fips:
        fip.instance_id = None
        fip.status = "available"


def get_attached_floating_ip(db: Session, instance_id: str) -> Optional[FloatingIP]:
    return db.query(FloatingIP).filter(FloatingIP.instance_id == instance_id).first()


def allocate_floating_port(db: Session) -> int:
    used_ports = set(
        p[0] for p in db.query(FloatingIP.public_port).all()
    )
    used_ports.update(
        p[0] for p in db.query(Instance.ssh_port).filter(Instance.ssh_port.isnot(None)).all()
    )
    for port in range(FLOATING_PORT_START, FLOATING_PORT_END + 1):
        if port not in used_ports:
            return port
    raise HTTPException(429, "Floating IP pool habis")


def allocate_ssh_port(db: Session) -> int:
    reserved = set(
        p[0] for p in db.query(FloatingIP.public_port).all()
    )
    reserved.update(
        p[0] for p in db.query(Instance.ssh_port).filter(Instance.ssh_port.isnot(None)).all()
    )
    return get_engine().next_ssh_port(reserved_ports=reserved)


def attach_floating_ip_to_instance(db: Session, inst: Instance, fip: FloatingIP):
    existing = get_attached_floating_ip(db, inst.id)
    if existing and existing.id != fip.id:
        raise HTTPException(409, "Instance sudah punya floating IP")
    if fip.status != "available" and fip.instance_id != inst.id:
        raise HTTPException(409, "Floating IP tidak tersedia")
    sg_id = inst.security_group_id
    if not sg_id:
        sg = get_default_security_group(db, inst.owner_id)
        sg_id = sg.id
        inst.security_group_id = sg_id
    if not security_group_allows_port(db, sg_id, 22):
        raise HTTPException(409, "Security group menolak akses SSH")
    inst.ssh_port = fip.public_port
    fip.instance_id = inst.id
    fip.status = "attached"
    inst.updated_at = datetime.utcnow()
    db.commit()
    if inst.container_id:
        net = None
        if inst.network_id:
            net = db.query(Network).filter(Network.id == inst.network_id).first()
        if not net:
            net = get_default_network(db, inst.owner_id)
        recreate_instance_with_volumes(db, inst, net)


def detach_floating_ip_from_instance(db: Session, inst: Instance, fip: FloatingIP):
    fip.instance_id = None
    fip.status = "available"
    if inst.status == InstanceStatus.TERMINATED:
        inst.updated_at = datetime.utcnow()
        db.commit()
        return

    sg_id = inst.security_group_id
    allow_ssh = False
    if sg_id:
        allow_ssh = security_group_allows_port(db, sg_id, 22)
    if allow_ssh:
        inst.ssh_port = allocate_ssh_port(db)
    else:
        inst.ssh_port = None
    inst.updated_at = datetime.utcnow()
    db.commit()

    if inst.container_id:
        net = None
        if inst.network_id:
            net = db.query(Network).filter(Network.id == inst.network_id).first()
        if not net:
            net = get_default_network(db, inst.owner_id)
        recreate_instance_with_volumes(db, inst, net)


# ── S3 / MinIO ────────────────────────────────────────────────
_s3_client = None


def get_s3_client() -> Minio:
    global _s3_client
    if _s3_client is None:
        _s3_client = Minio(
            MINIO_ENDPOINT,
            access_key=MINIO_ACCESS_KEY,
            secret_key=MINIO_SECRET_KEY,
            secure=MINIO_SECURE,
        )
    return _s3_client


def normalize_bucket_name(name: str) -> str:
    bucket = name.strip().lower()
    if not BUCKET_NAME_RE.match(bucket):
        raise HTTPException(
            400,
            "Nama bucket harus 3-63 karakter, huruf kecil/angka, dan boleh '-'.",
        )
    return bucket


def get_bucket_for_user(db: Session, user: User, bucket_name: str) -> ObjectBucket:
    bucket_key = bucket_name.strip().lower()
    bucket = db.query(ObjectBucket).filter(ObjectBucket.name == bucket_key).first()
    if not bucket:
        raise HTTPException(404, "Bucket tidak ditemukan")
    if not user.is_admin and bucket.owner_id != user.id:
        raise HTTPException(403, "Bukan milikmu")
    return bucket


# ── Network ────────────────────────────────────────────────────
def ensure_default_network(db: Session, owner_id: str) -> Network:
    net = db.query(Network).filter(Network.is_default == True).first()
    if net:
        return net
    try:
        info = get_engine().inspect_network(DOCKER_NETWORK)
        docker_name = info["name"]
        cidr = info.get("subnet")
        gateway = info.get("gateway")
    except Exception:
        created = get_engine().create_network(DOCKER_NETWORK)
        docker_name = created["name"]
        cidr = created.get("subnet")
        gateway = created.get("gateway")

    net = Network(
        id=str(uuid.uuid4()),
        name="default",
        owner_id=owner_id,
        cidr=cidr,
        gateway=gateway,
        docker_name=docker_name,
        is_default=True,
    )
    db.add(net)
    db.commit()
    return net


def get_default_network(db: Session, owner_id: str) -> Network:
    net = db.query(Network).filter(Network.is_default == True).first()
    if not net:
        net = ensure_default_network(db, owner_id)
    return net


def get_network_for_user(db: Session, user: User, network_id: str) -> Network:
    net = db.query(Network).filter(Network.id == network_id).first()
    if not net:
        raise HTTPException(404, "Network tidak ditemukan")
    if not user.is_admin and not net.is_default and net.owner_id != user.id:
        raise HTTPException(403, "Bukan milikmu")
    return net


# ── Images ──────────────────────────────────────────────────────
def resolve_image_for_user(db: Session, user: User, image_key: str) -> str:
    if image_key in AVAILABLE_IMAGES:
        return image_key
    snap = db.query(Snapshot).filter(Snapshot.id == image_key).first()
    if not snap:
        snap = db.query(Snapshot).filter(Snapshot.name == image_key).first()
    if not snap:
        snap = db.query(Snapshot).filter(Snapshot.image_ref == image_key).first()
    if snap:
        if not user.is_admin and snap.owner_id != user.id:
            raise HTTPException(403, "Bukan milikmu")
        return snap.image_ref
    raise HTTPException(400, "Image tidak tersedia")


# ── Volumes ─────────────────────────────────────────────────────
def build_volume_mounts(db: Session, instance_id: str):
    attachments = db.query(VolumeAttachment).filter(
        VolumeAttachment.instance_id == instance_id
    ).all()
    mounts = []
    for att in attachments:
        vol = db.query(Volume).filter(Volume.id == att.volume_id).first()
        if vol and vol.host_path:
            mounts.append({"volume_name": vol.host_path, "mount_path": att.mount_path})
    return mounts


def detach_all_volumes(db: Session, instance_id: str):
    attachments = db.query(VolumeAttachment).filter(
        VolumeAttachment.instance_id == instance_id
    ).all()
    for att in attachments:
        vol = db.query(Volume).filter(Volume.id == att.volume_id).first()
        if vol:
            vol.status = "available"
        db.delete(att)


def recreate_instance_with_volumes(db: Session, inst: Instance, network: Network):
    prev_status = inst.status
    mounts = build_volume_mounts(db, inst.id)
    result = get_engine().recreate_instance(
        container_id=inst.container_id,
        name=inst.name,
        image_key=inst.image,
        vcpu=inst.vcpu,
        memory_mb=inst.memory_mb,
        owner_id=inst.owner_id,
        instance_id=inst.id,
        network_name=network.docker_name,
        ssh_port=inst.ssh_port,
        ssh_password=inst.ssh_password,
        volume_mounts=mounts,
    )
    inst.container_id = result["container_id"]
    inst.ip_address   = result["ip_address"]
    inst.ssh_port     = result["ssh_port"]
    inst.ssh_password = result.get("ssh_password", inst.ssh_password)
    inst.status       = InstanceStatus.RUNNING
    inst.updated_at   = datetime.utcnow()
    db.commit()
    if prev_status == InstanceStatus.STOPPED:
        get_engine().stop_instance(inst.container_id)
        inst.status = InstanceStatus.STOPPED
        inst.updated_at = datetime.utcnow()
        db.commit()
