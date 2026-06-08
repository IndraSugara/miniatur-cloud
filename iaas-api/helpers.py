from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

import uuid
from minio import Minio
from sqlalchemy import text
from sqlalchemy.orm import Session

from config import (
    BUCKET_NAME_RE,
    FLOATING_PORT_END,
    FLOATING_PORT_START,
    MINIO_ACCESS_KEY,
    MINIO_ENDPOINT,
    MINIO_SECRET_KEY,
    MINIO_SECURE,
    PUBLIC_BASE_URL,
    PUBLIC_DOMAIN,
)
from compute import get_engine, AVAILABLE_IMAGES, DOCKER_NETWORK, _resolve_docker_image
from errors import (
    not_found,
    forbidden,
    conflict,
    bad_request,
    raise_error,
)
from models import (
    PublicEndpoint,
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
        not_found("Security group")
    if not user.is_admin and not sg.is_default and sg.owner_id != user.id:
        forbidden()
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


# ── Public Endpoints (formerly Floating IPs) ──────────────────
def get_public_endpoint_for_user(db: Session, user: User, ep_id: str) -> PublicEndpoint:
    ep = db.query(PublicEndpoint).filter(PublicEndpoint.id == ep_id).first()
    if not ep:
        not_found("Public endpoint")
    if not user.is_admin and ep.owner_id != user.id:
        forbidden()
    return ep


def release_public_endpoints_for_instance(db: Session, instance_id: str):
    eps = db.query(PublicEndpoint).filter(PublicEndpoint.instance_id == instance_id).all()
    for ep in eps:
        ep.instance_id = None
        ep.status = "available"


def get_attached_public_endpoint(db: Session, instance_id: str) -> Optional[PublicEndpoint]:
    return db.query(PublicEndpoint).filter(PublicEndpoint.instance_id == instance_id).first()


def allocate_floating_port(db: Session) -> int:
    try:
        db.execute(text("SELECT pg_advisory_xact_lock(1001)"))
    except Exception:
        pass
    used_ports = set(
        p[0] for p in db.query(PublicEndpoint.public_port).all()
    )
    used_ports.update(
        p[0] for p in db.query(Instance.ssh_port).filter(Instance.ssh_port.isnot(None)).all()
    )
    for port in range(FLOATING_PORT_START, FLOATING_PORT_END + 1):
        if port not in used_ports:
            return port
    raise_error(429, "PORT_POOL_EXHAUSTED", "Public endpoint port pool habis")


def allocate_ssh_port(db: Session) -> int:
    try:
        db.execute(text("SELECT pg_advisory_xact_lock(1002)"))
    except Exception:
        pass
    reserved = set(
        p[0] for p in db.query(PublicEndpoint.public_port).all()
    )
    reserved.update(
        p[0] for p in db.query(Instance.ssh_port).filter(Instance.ssh_port.isnot(None)).all()
    )
    return get_engine().next_ssh_port(reserved_ports=reserved)


def attach_public_endpoint_to_instance(db: Session, inst: Instance, ep: PublicEndpoint):
    existing = get_attached_public_endpoint(db, inst.id)
    if existing and existing.id != ep.id:
        conflict("Instance sudah punya public endpoint")
    if ep.status != "available" and ep.instance_id != inst.id:
        conflict("Public endpoint tidak tersedia")
    sg_id = inst.security_group_id
    if not sg_id:
        sg = get_default_security_group(db, inst.owner_id)
        sg_id = sg.id
        inst.security_group_id = sg_id
    if not security_group_allows_port(db, sg_id, 22):
        conflict("Security group menolak akses SSH")
    inst.ssh_port = ep.public_port
    ep.instance_id = inst.id
    ep.status = "attached"
    inst.updated_at = datetime.now(timezone.utc)
    db.commit()
    if inst.container_id:
        net = None
        if inst.network_id:
            net = db.query(Network).filter(Network.id == inst.network_id).first()
        if not net:
            net = get_default_network(db, inst.owner_id)
        recreate_instance_with_volumes(db, inst, net)


def detach_public_endpoint_from_instance(db: Session, inst: Instance, ep: PublicEndpoint):
    ep.instance_id = None
    ep.status = "available"
    if inst.status == InstanceStatus.TERMINATED:
        inst.updated_at = datetime.now(timezone.utc)
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
    inst.updated_at = datetime.now(timezone.utc)
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
        bad_request("Nama bucket harus 3-63 karakter, huruf kecil/angka, dan boleh '-'.")
    return bucket


def get_bucket_for_user(db: Session, user: User, bucket_name: str) -> ObjectBucket:
    bucket_key = bucket_name.strip().lower()
    bucket = db.query(ObjectBucket).filter(ObjectBucket.name == bucket_key).first()
    if not bucket:
        not_found("Bucket")
    if not user.is_admin and bucket.owner_id != user.id:
        forbidden()
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
        not_found("Network")
    if not user.is_admin and not net.is_default and net.owner_id != user.id:
        forbidden()
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
            forbidden()
        return snap.image_ref
    bad_request("Image tidak tersedia")


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
    """Recreate instance container, preserving user-installed state via commit."""
    from compute import INSTANCE_TYPES
    prev_status = inst.status
    mounts = build_volume_mounts(db, inst.id)
    gpu = INSTANCE_TYPES.get(inst.instance_type, {}).get("gpu", False)
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
        preserve_state=True,
        gpu=gpu,
    )
    inst.container_id = result["container_id"]
    inst.ip_address   = result["ip_address"]
    inst.ssh_port     = result["ssh_port"]
    inst.ssh_password = result.get("ssh_password", inst.ssh_password)
    inst.status       = InstanceStatus.RUNNING
    inst.updated_at   = datetime.now(timezone.utc)
    db.commit()
    if prev_status == InstanceStatus.STOPPED:
        get_engine().stop_instance(inst.container_id)
        inst.status = InstanceStatus.STOPPED
        inst.updated_at = datetime.now(timezone.utc)
        db.commit()


# ── Ingress Routing ────────────────────────────────────────────
import logging as _logging
_hlog = _logging.getLogger("iaas.helpers")

# Paths that must not be overridden by user ingress rules
_RESERVED_PATHS = {"/api/", "/monitor/", "/storage/", "/storage-console/", "/metrics/"}


def _slugify(name: str) -> str:
    """Convert instance name to a safe DNS label."""
    import re
    slug = re.sub(r"[^a-z0-9-]", "-", name.lower())
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug[:50] or "instance"


def ensure_gateway_connected_to_network(docker_name: str):
    """Connect cloud-gateway to the given Docker network so Nginx can reach containers."""
    import docker as _docker
    try:
        eng = get_engine()
        gw  = eng.client.containers.get("cloud-gateway")
        net = eng.client.networks.get(docker_name)
        net.connect(gw)
    except _docker.errors.APIError as e:
        if "already exists in network" not in str(e):
            _hlog.warning(f"Gateway connect to {docker_name}: {e}")
    except Exception as e:
        _hlog.warning(f"Gateway network connect skipped: {e}")


def _nginx_server_block(hostname: str, container_ip: str, port: int) -> str:
    """Generate a Nginx server block for a specific instance subdomain."""
    return f"""server {{
    listen 80;
    server_name {hostname};

    location / {{
        proxy_pass          http://{container_ip}:{port}/;
        proxy_set_header    Host $host;
        proxy_set_header    X-Real-IP $remote_addr;
        proxy_set_header    X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header    X-Forwarded-Proto $scheme;
        proxy_http_version  1.1;
        proxy_set_header    Upgrade $http_upgrade;
        proxy_set_header    Connection "upgrade";
        proxy_read_timeout  300s;
        proxy_connect_timeout 10s;
    }}
}}
"""


def sync_nginx_subdomain(db: Session, instance: "Instance"):
    """Write / remove the per-instance Nginx server block and reload Nginx.

    Call this whenever an instance expose_port or public_hostname changes.
    """
    import os
    subdomains_dir = "/app/ingress/subdomains"
    os.makedirs(subdomains_dir, exist_ok=True)
    conf_path = os.path.join(subdomains_dir, f"{instance.id}.conf")

    # Remove stale file when instance is no longer exposed / running
    if not instance.public_hostname or not instance.expose_port or not instance.ip_address:
        if os.path.exists(conf_path):
            os.remove(conf_path)
            _reload_nginx()
        return

    block = _nginx_server_block(instance.public_hostname, instance.ip_address, instance.expose_port)
    with open(conf_path, "w") as f:
        f.write(block)
    _hlog.info(f"Nginx subdomain block written: {instance.public_hostname} -> {instance.ip_address}:{instance.expose_port}")
    _reload_nginx()


def rebuild_all_nginx_subdomains(db: Session):
    """Rebuild ALL per-instance subdomain blocks (call on startup / bulk sync)."""
    import os
    subdomains_dir = "/app/ingress/subdomains"
    os.makedirs(subdomains_dir, exist_ok=True)

    # Remove old files first
    for fname in os.listdir(subdomains_dir):
        if fname.endswith(".conf"):
            os.remove(os.path.join(subdomains_dir, fname))

    instances = db.query(Instance).filter(
        Instance.public_hostname.isnot(None),
        Instance.expose_port.isnot(None),
        Instance.ip_address.isnot(None),
        Instance.status == InstanceStatus.RUNNING,
    ).all()

    for inst in instances:
        if inst.network_id:
            net = db.query(Network).filter(Network.id == inst.network_id).first()
            if net:
                ensure_gateway_connected_to_network(net.docker_name)
        conf_path = os.path.join(subdomains_dir, f"{inst.id}.conf")
        block = _nginx_server_block(inst.public_hostname, inst.ip_address, inst.expose_port)
        with open(conf_path, "w") as f:
            f.write(block)

    _reload_nginx()
    _hlog.info(f"Rebuilt {len(instances)} nginx subdomain blocks")


def _reload_nginx():
    """Signal Nginx to reload config without downtime."""
    try:
        container = get_engine().client.containers.get("cloud-gateway")
        res = container.exec_run("nginx -s reload")
        if res.exit_code != 0:
            _hlog.warning(f"Nginx reload warning: {res.output.decode()[:200]}")
    except Exception as e:
        _hlog.error(f"Nginx reload error: {e}")





# ── SSH Proxy (sshpiper) Sync ──────────────────────────────────
import yaml as _yaml

def sync_sshpiper_config(db: Session):
    """Regenerate sshpiper YAML config with pipes for all running instances.

    Each running instance with an IP address gets a pipe entry where
    the downstream username is the first 8 chars of the instance ID
    and the upstream target is the container's internal IP on port 22.

    sshpiper reads the YAML on each new connection, so no reload signal
    is strictly required, but we send one for good measure.
    """
    from config import PUBLIC_HOST
    import os

    instances = db.query(Instance).filter(
        Instance.status == InstanceStatus.RUNNING,
        Instance.ip_address.isnot(None),
    ).all()

    # Static routes untuk host Jetson
    pipes = [
        {
            "from": [{"username": "sugara-jetson"}],
            "to": {
                "host": f"{PUBLIC_HOST}:2200",
                "username": "sugara-jetson",
                "ignore_hostkey": True,
            }
        },
        {
            "from": [{"username": "root"}],
            "to": {
                "host": f"{PUBLIC_HOST}:2200",
                "username": "root",
                "ignore_hostkey": True,
            }
        }
    ]

    for inst in instances:
        if not inst.ssh_port:
            continue
        pipe = {
            "from": [{"username": inst.id[:8]}],
            "to": {
                "host": f"{PUBLIC_HOST}:{inst.ssh_port}",
                "username": "root",
                "ignore_hostkey": True,
            },
        }
        pipes.append(pipe)

    config = {
        "version": "1.0",
        "pipes": pipes,
    }

    sshpiper_dir = "/app/sshpiper"
    os.makedirs(sshpiper_dir, exist_ok=True)
    conf_path = os.path.join(sshpiper_dir, "sshpiperd.yaml")

    with open(conf_path, "w") as f:
        f.write("# Auto-generated by iaas-api. DO NOT EDIT MANUALLY.\n")
        _yaml.dump(config, f, default_flow_style=False, sort_keys=False)

    _hlog.info(f"sshpiper config synced: {len(pipes)} pipes")

