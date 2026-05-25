from __future__ import annotations

from fastapi import FastAPI, Depends, HTTPException, status, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime, timedelta
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import create_engine, text, or_, and_
from sqlalchemy.orm import sessionmaker, Session
from models import (
    Base,
    User,
    Instance,
    Volume,
    InstanceStatus,
    Network,
    VolumeAttachment,
    ObjectBucket,
    SecurityGroup,
    SecurityGroupRule,
    Snapshot,
    FloatingIP,
)
from compute import get_engine, INSTANCE_TYPES, AVAILABLE_IMAGES, DOCKER_NETWORK
from minio import Minio
from minio.error import S3Error
import uuid, os, logging, re

# ── Config ───────────────────────────────────────────────────
SECRET_KEY   = os.getenv("SECRET_KEY", "iaas-jetson-secret-ganti-ini")
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

logging.basicConfig(level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")
log = logging.getLogger("iaas.api")

# ── Database ─────────────────────────────────────────────────
engine  = create_engine(DB_SYNC_URL, connect_args={"check_same_thread": False})
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

# ── Authentication ──────────────────────────────────────────────────────
pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2  = OAuth2PasswordBearer(tokenUrl="/auth/token")

def hash_password(pw):    return pwd_ctx.hash(pw)
def verify_password(p,h): return pwd_ctx.verify(p, h)

def create_token(data: dict):
    payload = data.copy()
    payload["exp"] = datetime.utcnow() + timedelta(minutes=TOKEN_EXPIRE)
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)

def get_current_user(token: str = Depends(oauth2), db: Session = Depends(get_db)):
    exc = HTTPException(status_code=401, detail="Token tidak valid",
                        headers={"WWW-Authenticate": "Bearer"})
    try:
        payload  = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username = payload.get("sub")
        if not username: raise exc
        user = db.query(User).filter(User.username == username).first()
        if not user: raise exc
        return user
    except JWTError:
        raise exc

def require_admin(user: User = Depends(get_current_user)):
    if not user.is_admin:
        raise HTTPException(403, "Hanya admin yang bisa akses")
    return user

# ── Schemas ───────────────────────────────────────────────────
class UserRegister(BaseModel):
    username: str = Field(..., min_length=3, max_length=32)
    email:    str
    password: str = Field(..., min_length=6)

class InstanceCreate(BaseModel):
    name          : str = Field(..., min_length=2, max_length=64)
    image         : str = Field(default="ubuntu-22.04")
    instance_type : str = Field(default="nano.small")
    network_id    : Optional[str] = None
    volume_ids    : Optional[List[str]] = None
    security_group_id: Optional[str] = None
    floating_ip_id: Optional[str] = None

class InstanceAction(BaseModel):
    action: str  # start | stop | reboot | terminate

class ExecCommand(BaseModel):
    command: str

class VolumeCreate(BaseModel):
    name    : str
    size_gb : int = Field(default=2, ge=1, le=20)

class VolumeAttach(BaseModel):
    instance_id: str
    mount_path : Optional[str] = None

class VolumeDetach(BaseModel):
    instance_id: str

class NetworkCreate(BaseModel):
    name   : str = Field(..., min_length=2, max_length=64)
    cidr   : Optional[str] = None
    gateway: Optional[str] = None

class InstanceNetworkUpdate(BaseModel):
    network_id: str

class InstanceSecurityGroupUpdate(BaseModel):
    security_group_id: str

class SecurityGroupCreate(BaseModel):
    name: str = Field(..., min_length=2, max_length=64)

class SecurityGroupRuleCreate(BaseModel):
    port_min: int = Field(..., ge=1, le=65535)
    port_max: int = Field(..., ge=1, le=65535)
    cidr: str = Field(default="0.0.0.0/0", min_length=3, max_length=32)

class SnapshotCreate(BaseModel):
    name: Optional[str] = Field(None, min_length=2, max_length=128)

class FloatingIPCreate(BaseModel):
    instance_id: Optional[str] = None

class FloatingIPAttach(BaseModel):
    instance_id: str

class BucketCreate(BaseModel):
    name: Optional[str] = Field(None, min_length=3, max_length=63)

class PresignRequest(BaseModel):
    object_key: str = Field(..., min_length=1, max_length=1024)
    expiry_seconds: int = Field(default=3600, ge=60, le=604800)

# ── App ───────────────────────────────────────────────────────
app = FastAPI(
    title="Miniatur IaaS API",
    description="Infrastructure as a Service — Jetson Nano",
    version="1.0.0",
)

app.add_middleware(CORSMiddleware, allow_origins=["*"],
    allow_methods=["*"], allow_headers=["*"], allow_credentials=True)

# ── Startup: buat admin default ───────────────────────────────
@app.on_event("startup")
def startup():
    db = SessionLocal()
    admin = db.query(User).filter(User.username == "admin").first()
    if not admin:
        admin = User(
            id=str(uuid.uuid4()), username="admin",
            email="admin@iaas.local",
            hashed_password=hash_password("admin123"),
            is_admin=True, quota_instances=10,
        )
        db.add(admin)
        db.commit()
        log.info("Admin default dibuat: admin / admin123")

    try:
        ensure_default_network(db, admin.id)
        ensure_default_security_group(db, admin.id)
    except Exception as e:
        log.error(f"Gagal memastikan default network: {e}")
    db.close()

# ════════════════════════════════════════════════════════════
# AUTH
# ════════════════════════════════════════════════════════════
@app.post("/auth/register", tags=["Auth"])
def register(body: UserRegister, db: Session = Depends(get_db)):
    if db.query(User).filter(User.username == body.username).first():
        raise HTTPException(409, "Username sudah dipakai")
    user = User(
        id=str(uuid.uuid4()), username=body.username,
        email=body.email,
        hashed_password=hash_password(body.password),
    )
    db.add(user); db.commit()
    return {"message": "Registrasi berhasil", "username": body.username}

@app.post("/auth/token", tags=["Auth"])
def login(form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == form.username).first()
    if not user or not verify_password(form.password, user.hashed_password):
        raise HTTPException(401, "Username atau password salah")
    return {"access_token": create_token({"sub": user.username}), "token_type": "bearer"}

@app.get("/auth/me", tags=["Auth"])
def me(user: User = Depends(get_current_user)):
    return {"id": user.id, "username": user.username,
            "email": user.email, "is_admin": user.is_admin,
            "quota_instances": user.quota_instances}

@app.get("/admin/users", tags=["Admin"])
def list_users(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    users = db.query(User).order_by(User.created_at.desc()).all()
    return {
        "users": [
            {
                "id": u.id,
                "username": u.username,
                "email": u.email,
                "is_admin": u.is_admin,
                "is_active": u.is_active,
                "quota_instances": u.quota_instances,
                "created_at": str(u.created_at),
            }
            for u in users
        ]
    }

# ════════════════════════════════════════════════════════════
# INSTANCES (Compute)
# ════════════════════════════════════════════════════════════
@app.get("/instances", tags=["Compute"])
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

@app.post("/instances", status_code=201, tags=["Compute"])
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

@app.get("/instances/{iid}", tags=["Compute"])
def get_instance(iid: str, user: User = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    inst = db.query(Instance).filter(Instance.id == iid).first()
    if not inst: raise HTTPException(404, "Instance tidak ditemukan")
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

@app.get("/instances/{iid}/status", tags=["Compute"])
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

@app.post("/instances/{iid}/action", tags=["Compute"])
def instance_action(iid: str, body: InstanceAction,
                    user: User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    inst = db.query(Instance).filter(Instance.id == iid).first()
    if not inst: raise HTTPException(404, "Instance tidak ditemukan")
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
    return {"message": f"Action '{action}' berhasil", "status": inst.status}

@app.post("/instances/{iid}/exec", tags=["Compute"])
def exec_command(iid: str, body: ExecCommand,
                 user: User = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    inst = db.query(Instance).filter(Instance.id == iid).first()
    if not inst or not inst.container_id:
        raise HTTPException(404, "Instance tidak ditemukan atau belum siap")
    return get_engine().exec_command(inst.container_id, body.command)

@app.post("/instances/{iid}/snapshot", status_code=201, tags=["Compute"])
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

@app.get("/snapshots", tags=["Compute"])
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

@app.delete("/snapshots/{sid}", tags=["Compute"])
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

@app.post("/instances/{iid}/network", tags=["Network"])
def update_instance_network(iid: str, body: InstanceNetworkUpdate,
                            user: User = Depends(get_current_user),
                            db: Session = Depends(get_db)):
    inst = db.query(Instance).filter(Instance.id == iid).first()
    if not inst:
        raise HTTPException(404, "Instance tidak ditemukan")
    if inst.owner_id != user.id and not user.is_admin:
        raise HTTPException(403, "Bukan milikmu")
    if inst.status == InstanceStatus.TERMINATED:
        raise HTTPException(400, "Instance sudah terminated")
    if not inst.container_id:
        raise HTTPException(400, "Container belum siap")

    net = get_network_for_user(db, user, body.network_id)
    if inst.network_id == net.id:
        return {"message": "Network tidak berubah", "network_id": net.id, "ip_address": inst.ip_address}

    if inst.network_id:
        old_net = db.query(Network).filter(Network.id == inst.network_id).first()
        if old_net:
            try:
                get_engine().disconnect_network(inst.container_id, old_net.docker_name)
            except Exception:
                pass

    try:
        get_engine().connect_network(inst.container_id, net.docker_name)
    except Exception:
        pass

    inst.ip_address = get_engine().get_container_network_ip(inst.container_id, net.docker_name)
    inst.network_id = net.id
    inst.updated_at = datetime.utcnow()
    db.commit()
    return {"message": "Network updated", "network_id": net.id, "ip_address": inst.ip_address}

@app.post("/instances/{iid}/security-group", tags=["Network"])
def update_instance_security_group(iid: str, body: InstanceSecurityGroupUpdate,
                                   user: User = Depends(get_current_user),
                                   db: Session = Depends(get_db)):
    inst = db.query(Instance).filter(Instance.id == iid).first()
    if not inst:
        raise HTTPException(404, "Instance tidak ditemukan")
    if inst.owner_id != user.id and not user.is_admin:
        raise HTTPException(403, "Bukan milikmu")
    if inst.status == InstanceStatus.TERMINATED:
        raise HTTPException(400, "Instance sudah terminated")

    sg = get_security_group_for_user(db, user, body.security_group_id)
    allow_ssh = security_group_allows_port(db, sg.id, 22)
    fip = get_attached_floating_ip(db, inst.id)
    if not allow_ssh:
        if fip:
            fip.instance_id = None
            fip.status = "available"
        inst.ssh_port = None
    elif allow_ssh and not inst.ssh_port:
        inst.ssh_port = allocate_ssh_port(db)

    inst.security_group_id = sg.id
    inst.updated_at = datetime.utcnow()
    db.commit()

    if inst.container_id:
        net = None
        if inst.network_id:
            net = db.query(Network).filter(Network.id == inst.network_id).first()
        if not net:
            net = get_default_network(db, inst.owner_id)
        recreate_instance_with_volumes(db, inst, net)

    return {"message": "Security group updated", "security_group_id": sg.id, "ssh_port": inst.ssh_port}

# ════════════════════════════════════════════════════════════
# NETWORK
# ════════════════════════════════════════════════════════════
@app.get("/networks", tags=["Network"])
def list_networks(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    q = db.query(Network)
    if not user.is_admin:
        q = q.filter(or_(Network.is_default == True, Network.owner_id == user.id))
    nets = q.all()
    return {
        "networks": [
            {
                "id": n.id,
                "name": n.name,
                "cidr": n.cidr,
                "gateway": n.gateway,
                "docker_name": n.docker_name,
                "is_default": n.is_default,
                "owner_id": n.owner_id,
                "created_at": str(n.created_at),
            }
            for n in nets
        ]
    }

@app.post("/networks", status_code=201, tags=["Network"])
def create_network(body: NetworkCreate, user: User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    docker_name = f"iaas-net-{uuid.uuid4().hex[:8]}"
    result = get_engine().create_network(docker_name, body.cidr, body.gateway)
    net = Network(
        id=str(uuid.uuid4()),
        name=body.name,
        owner_id=user.id,
        cidr=body.cidr or result.get("subnet"),
        gateway=body.gateway or result.get("gateway"),
        docker_name=result["name"],
        is_default=False,
    )
    db.add(net)
    db.commit()
    return {"network_id": net.id, "name": net.name}

@app.delete("/networks/{nid}", tags=["Network"])
def delete_network(nid: str, user: User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    net = db.query(Network).filter(Network.id == nid).first()
    if not net:
        raise HTTPException(404, "Network tidak ditemukan")
    if net.is_default:
        raise HTTPException(400, "Default network tidak bisa dihapus")
    if not user.is_admin and net.owner_id != user.id:
        raise HTTPException(403, "Bukan milikmu")
    in_use = db.query(Instance).filter(
        Instance.network_id == net.id,
        Instance.status != InstanceStatus.TERMINATED,
    ).count()
    if in_use > 0:
        raise HTTPException(409, "Network masih dipakai instance")
    get_engine().remove_network(net.docker_name)
    db.delete(net)
    db.commit()
    return {"message": "Network dihapus"}

@app.get("/security-groups", tags=["Network"])
def list_security_groups(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    q = db.query(SecurityGroup)
    if not user.is_admin:
        q = q.filter(or_(SecurityGroup.is_default == True, SecurityGroup.owner_id == user.id))
    groups = q.all()
    sg_ids = [g.id for g in groups]
    rules_map = {}
    if sg_ids:
        rules = db.query(SecurityGroupRule).filter(SecurityGroupRule.group_id.in_(sg_ids)).all()
        for r in rules:
            rules_map.setdefault(r.group_id, []).append({
                "id": r.id,
                "direction": r.direction,
                "protocol": r.protocol,
                "port_min": r.port_min,
                "port_max": r.port_max,
                "cidr": r.cidr,
            })
    return {
        "security_groups": [
            {
                "id": g.id,
                "name": g.name,
                "owner_id": g.owner_id,
                "is_default": g.is_default,
                "created_at": str(g.created_at),
                "rules": rules_map.get(g.id, []),
            }
            for g in groups
        ]
    }

@app.post("/security-groups", status_code=201, tags=["Network"])
def create_security_group(body: SecurityGroupCreate,
                          user: User = Depends(get_current_user),
                          db: Session = Depends(get_db)):
    exists = db.query(SecurityGroup).filter(
        SecurityGroup.owner_id == user.id,
        SecurityGroup.name == body.name,
    ).first()
    if exists:
        raise HTTPException(409, "Security group sudah ada")
    sg = SecurityGroup(
        id=str(uuid.uuid4()),
        name=body.name,
        owner_id=user.id,
        is_default=False,
    )
    db.add(sg)
    db.commit()
    return {"security_group_id": sg.id, "name": sg.name}

@app.delete("/security-groups/{sid}", tags=["Network"])
def delete_security_group(sid: str, user: User = Depends(get_current_user),
                          db: Session = Depends(get_db)):
    sg = db.query(SecurityGroup).filter(SecurityGroup.id == sid).first()
    if not sg:
        raise HTTPException(404, "Security group tidak ditemukan")
    if sg.is_default:
        raise HTTPException(400, "Default security group tidak bisa dihapus")
    if not user.is_admin and sg.owner_id != user.id:
        raise HTTPException(403, "Bukan milikmu")
    in_use = db.query(Instance).filter(Instance.security_group_id == sg.id).count()
    if in_use > 0:
        raise HTTPException(409, "Security group masih dipakai instance")
    db.query(SecurityGroupRule).filter(SecurityGroupRule.group_id == sg.id).delete()
    db.delete(sg)
    db.commit()
    return {"message": "Security group dihapus"}

@app.post("/security-groups/{sid}/rules", status_code=201, tags=["Network"])
def add_security_group_rule(sid: str, body: SecurityGroupRuleCreate,
                            user: User = Depends(get_current_user),
                            db: Session = Depends(get_db)):
    sg = get_security_group_for_user(db, user, sid)
    if body.port_min > body.port_max:
        raise HTTPException(400, "port_min harus <= port_max")
    rule = SecurityGroupRule(
        id=str(uuid.uuid4()),
        group_id=sg.id,
        direction="ingress",
        protocol="tcp",
        port_min=body.port_min,
        port_max=body.port_max,
        cidr=body.cidr,
    )
    db.add(rule)
    db.commit()
    return {"rule_id": rule.id}

@app.delete("/security-groups/{sid}/rules/{rid}", tags=["Network"])
def delete_security_group_rule(sid: str, rid: str,
                               user: User = Depends(get_current_user),
                               db: Session = Depends(get_db)):
    sg = get_security_group_for_user(db, user, sid)
    rule = db.query(SecurityGroupRule).filter(
        SecurityGroupRule.id == rid,
        SecurityGroupRule.group_id == sg.id,
    ).first()
    if not rule:
        raise HTTPException(404, "Rule tidak ditemukan")
    db.delete(rule)
    db.commit()
    return {"message": "Rule dihapus"}

# ════════════════════════════════════════════════════════════
# FLOATING IP
# ════════════════════════════════════════════════════════════
@app.get("/floating-ips", tags=["Network"])
def list_floating_ips(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    q = db.query(FloatingIP)
    if not user.is_admin:
        q = q.filter(FloatingIP.owner_id == user.id)
    fips = q.order_by(FloatingIP.created_at.desc()).all()
    return {
        "floating_ips": [
            {
                "id": f.id,
                "public_ip": f.public_ip,
                "public_port": f.public_port,
                "instance_id": f.instance_id,
                "status": f.status,
                "created_at": str(f.created_at),
            }
            for f in fips
        ]
    }

@app.post("/floating-ips", status_code=201, tags=["Network"])
def allocate_floating_ip(body: FloatingIPCreate,
                          user: User = Depends(get_current_user),
                          db: Session = Depends(get_db)):
    port = allocate_floating_port(db)
    fip = FloatingIP(
        id=str(uuid.uuid4()),
        owner_id=user.id,
        public_ip=PUBLIC_HOST,
        public_port=port,
        status="available",
    )
    db.add(fip)
    db.commit()

    if body.instance_id:
        inst = db.query(Instance).filter(Instance.id == body.instance_id).first()
        if not inst:
            raise HTTPException(404, "Instance tidak ditemukan")
        if not user.is_admin and inst.owner_id != user.id:
            raise HTTPException(403, "Bukan milikmu")
        if inst.status in [InstanceStatus.TERMINATED, InstanceStatus.ERROR, InstanceStatus.PENDING]:
            raise HTTPException(400, "Instance belum siap")
        attach_floating_ip_to_instance(db, inst, fip)

    return {"floating_ip_id": fip.id, "public_ip": fip.public_ip, "public_port": fip.public_port}

@app.post("/floating-ips/{fid}/attach", tags=["Network"])
def attach_floating_ip(fid: str, body: FloatingIPAttach,
                       user: User = Depends(get_current_user),
                       db: Session = Depends(get_db)):
    fip = get_floating_ip_for_user(db, user, fid)
    if fip.instance_id:
        raise HTTPException(409, "Floating IP sudah terpasang")
    inst = db.query(Instance).filter(Instance.id == body.instance_id).first()
    if not inst:
        raise HTTPException(404, "Instance tidak ditemukan")
    if not user.is_admin and inst.owner_id != user.id:
        raise HTTPException(403, "Bukan milikmu")
    if inst.status in [InstanceStatus.TERMINATED, InstanceStatus.ERROR, InstanceStatus.PENDING]:
        raise HTTPException(400, "Instance belum siap")
    attach_floating_ip_to_instance(db, inst, fip)
    return {"message": "Floating IP attached", "public_ip": fip.public_ip, "public_port": fip.public_port}

@app.post("/floating-ips/{fid}/detach", tags=["Network"])
def detach_floating_ip(fid: str,
                       user: User = Depends(get_current_user),
                       db: Session = Depends(get_db)):
    fip = get_floating_ip_for_user(db, user, fid)
    if not fip.instance_id:
        raise HTTPException(409, "Floating IP belum terpasang")
    inst = db.query(Instance).filter(Instance.id == fip.instance_id).first()
    if inst:
        detach_floating_ip_from_instance(db, inst, fip)
    else:
        fip.instance_id = None
        fip.status = "available"
        db.commit()
    return {"message": "Floating IP detached"}

@app.delete("/floating-ips/{fid}", tags=["Network"])
def release_floating_ip(fid: str, user: User = Depends(get_current_user),
                        db: Session = Depends(get_db)):
    fip = get_floating_ip_for_user(db, user, fid)
    if fip.instance_id:
        raise HTTPException(409, "Floating IP masih terpasang")
    db.delete(fip)
    db.commit()
    return {"message": "Floating IP dilepas"}

# ════════════════════════════════════════════════════════════
# STORAGE (Volumes)
# ════════════════════════════════════════════════════════════
@app.get("/volumes", tags=["Storage"])
def list_volumes(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    q = db.query(Volume)
    if not user.is_admin:
        q = q.filter(Volume.owner_id == user.id)
    vols = q.all()
    vol_ids = [v.id for v in vols]
    attachments = []
    if vol_ids:
        attachments = db.query(VolumeAttachment).filter(
            VolumeAttachment.volume_id.in_(vol_ids)
        ).all()
    attach_map = {a.volume_id: a for a in attachments}
    return {
        "volumes": [
            {
                "id": v.id,
                "name": v.name,
                "size_gb": v.size_gb,
                "status": v.status,
                "attached_instance_id": attach_map.get(v.id).instance_id if attach_map.get(v.id) else None,
                "mount_path": attach_map.get(v.id).mount_path if attach_map.get(v.id) else None,
                "created_at": str(v.created_at),
            }
            for v in vols
        ]
    }

@app.post("/volumes", status_code=201, tags=["Storage"])
def create_volume(body: VolumeCreate, user: User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    vid = str(uuid.uuid4())
    docker_name = f"iaas-vol-{vid}"
    docker_name = get_engine().create_volume(docker_name)
    vol = Volume(
        id=vid,
        name=body.name,
        owner_id=user.id,
        size_gb=body.size_gb,
        host_path=docker_name,
        status="available",
    )
    db.add(vol)
    db.commit()
    return {"volume_id": vid, "name": body.name, "size_gb": body.size_gb}

@app.delete("/volumes/{vid}", tags=["Storage"])
def delete_volume(vid: str, user: User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    vol = db.query(Volume).filter(Volume.id == vid).first()
    if not vol:
        raise HTTPException(404, "Volume tidak ditemukan")
    if not user.is_admin and vol.owner_id != user.id:
        raise HTTPException(403, "Bukan milikmu")
    if vol.status != "available":
        raise HTTPException(409, "Volume sedang terpasang")
    attach = db.query(VolumeAttachment).filter(VolumeAttachment.volume_id == vid).first()
    if attach:
        raise HTTPException(409, "Volume sedang terpasang")
    if vol.host_path:
        get_engine().remove_volume(vol.host_path)
    db.delete(vol)
    db.commit()
    return {"message": "Volume dihapus"}

@app.post("/volumes/{vid}/attach", tags=["Storage"])
def attach_volume(vid: str, body: VolumeAttach,
                  user: User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    vol = db.query(Volume).filter(Volume.id == vid).first()
    if not vol:
        raise HTTPException(404, "Volume tidak ditemukan")
    if not user.is_admin and vol.owner_id != user.id:
        raise HTTPException(403, "Bukan milikmu")
    if vol.status != "available":
        raise HTTPException(409, "Volume sedang terpasang")

    inst = db.query(Instance).filter(Instance.id == body.instance_id).first()
    if not inst:
        raise HTTPException(404, "Instance tidak ditemukan")
    if not user.is_admin and inst.owner_id != user.id:
        raise HTTPException(403, "Bukan milikmu")
    if inst.status in [InstanceStatus.TERMINATED, InstanceStatus.ERROR, InstanceStatus.PENDING]:
        raise HTTPException(400, "Instance belum siap")

    existing = db.query(VolumeAttachment).filter(VolumeAttachment.volume_id == vid).first()
    if existing:
        raise HTTPException(409, "Volume sudah terpasang")

    mount_path = body.mount_path or f"/mnt/vol-{vid}"
    db.add(VolumeAttachment(
        id=str(uuid.uuid4()),
        volume_id=vid,
        instance_id=inst.id,
        mount_path=mount_path,
    ))
    vol.status = "in-use"
    db.commit()

    net = None
    if inst.network_id:
        net = db.query(Network).filter(Network.id == inst.network_id).first()
    if not net:
        net = get_default_network(db, inst.owner_id)
    recreate_instance_with_volumes(db, inst, net)
    return {"message": "Volume attached", "volume_id": vid, "instance_id": inst.id}

@app.post("/volumes/{vid}/detach", tags=["Storage"])
def detach_volume(vid: str, body: VolumeDetach,
                  user: User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    vol = db.query(Volume).filter(Volume.id == vid).first()
    if not vol:
        raise HTTPException(404, "Volume tidak ditemukan")
    if not user.is_admin and vol.owner_id != user.id:
        raise HTTPException(403, "Bukan milikmu")

    inst = db.query(Instance).filter(Instance.id == body.instance_id).first()
    if not inst:
        raise HTTPException(404, "Instance tidak ditemukan")
    if not user.is_admin and inst.owner_id != user.id:
        raise HTTPException(403, "Bukan milikmu")

    attach = db.query(VolumeAttachment).filter(
        VolumeAttachment.volume_id == vid,
        VolumeAttachment.instance_id == inst.id,
    ).first()
    if not attach:
        raise HTTPException(404, "Attachment tidak ditemukan")

    db.delete(attach)
    vol.status = "available"
    db.commit()

    if inst.status != InstanceStatus.TERMINATED:
        net = None
        if inst.network_id:
            net = db.query(Network).filter(Network.id == inst.network_id).first()
        if not net:
            net = get_default_network(db, inst.owner_id)
        recreate_instance_with_volumes(db, inst, net)

    return {"message": "Volume detached", "volume_id": vid, "instance_id": inst.id}

# ════════════════════════════════════════════════════════════
# OBJECT STORAGE (S3-like)
# ════════════════════════════════════════════════════════════
@app.get("/storage/buckets", tags=["ObjectStorage"])
def list_buckets(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    q = db.query(ObjectBucket)
    if not user.is_admin:
        q = q.filter(ObjectBucket.owner_id == user.id)
    buckets = q.order_by(ObjectBucket.created_at.desc()).all()
    return {
        "buckets": [
            {
                "name": b.name,
                "owner_id": b.owner_id,
                "created_at": str(b.created_at),
            }
            for b in buckets
        ]
    }

@app.post("/storage/buckets", status_code=201, tags=["ObjectStorage"])
def create_bucket(body: BucketCreate, user: User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    if body.name:
        bucket_name = normalize_bucket_name(body.name)
    else:
        owner_slug = re.sub(r"[^a-z0-9-]+", "-", user.username.lower()).strip("-")
        max_owner = 63 - 1 - 8
        if len(owner_slug) > max_owner:
            owner_slug = owner_slug[:max_owner].strip("-")
        if not owner_slug:
            owner_slug = "user"
        base = f"{owner_slug}-{uuid.uuid4().hex[:8]}"
        bucket_name = normalize_bucket_name(base)

    exists = db.query(ObjectBucket).filter(ObjectBucket.name == bucket_name).first()
    if exists:
        raise HTTPException(409, "Bucket sudah terdaftar")

    s3 = get_s3_client()
    try:
        if s3.bucket_exists(bucket_name):
            raise HTTPException(409, "Bucket sudah ada")
        s3.make_bucket(bucket_name)
    except HTTPException:
        raise
    except S3Error as e:
        raise HTTPException(400, f"S3 error: {e.code}")
    except Exception as e:
        raise HTTPException(502, f"MinIO error: {e}")

    bucket = ObjectBucket(
        id=str(uuid.uuid4()),
        name=bucket_name,
        owner_id=user.id,
    )
    db.add(bucket)
    db.commit()
    return {"name": bucket.name}

@app.delete("/storage/buckets/{bucket}", tags=["ObjectStorage"])
def delete_bucket(bucket: str, force: bool = False,
                  user: User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    bucket_row = get_bucket_for_user(db, user, bucket)
    s3 = get_s3_client()
    try:
        if force:
            objects = s3.list_objects(bucket_row.name, recursive=True)
            for obj in objects:
                s3.remove_object(bucket_row.name, obj.object_name)
        else:
            for _ in s3.list_objects(bucket_row.name, recursive=True):
                raise HTTPException(409, "Bucket tidak kosong")
        s3.remove_bucket(bucket_row.name)
    except HTTPException:
        raise
    except S3Error as e:
        raise HTTPException(400, f"S3 error: {e.code}")
    except Exception as e:
        raise HTTPException(502, f"MinIO error: {e}")

    db.delete(bucket_row)
    db.commit()
    return {"message": "Bucket dihapus"}

@app.get("/storage/buckets/{bucket}/objects", tags=["ObjectStorage"])
def list_objects(bucket: str, prefix: Optional[str] = None, limit: int = 200,
                 user: User = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    bucket_row = get_bucket_for_user(db, user, bucket)
    limit = max(1, min(limit, 1000))
    s3 = get_s3_client()
    objects = []
    try:
        for obj in s3.list_objects(bucket_row.name, prefix=prefix or "", recursive=True):
            objects.append({
                "key": obj.object_name,
                "size": obj.size,
                "etag": obj.etag,
                "last_modified": obj.last_modified.isoformat() if obj.last_modified else None,
            })
            if len(objects) >= limit:
                break
    except S3Error as e:
        raise HTTPException(400, f"S3 error: {e.code}")
    except Exception as e:
        raise HTTPException(502, f"MinIO error: {e}")
    return {"objects": objects}

@app.delete("/storage/buckets/{bucket}/objects", tags=["ObjectStorage"])
def delete_object(bucket: str, object_key: str,
                  user: User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    if not object_key:
        raise HTTPException(400, "object_key wajib")
    bucket_row = get_bucket_for_user(db, user, bucket)
    s3 = get_s3_client()
    try:
        s3.remove_object(bucket_row.name, object_key)
    except S3Error as e:
        raise HTTPException(400, f"S3 error: {e.code}")
    except Exception as e:
        raise HTTPException(502, f"MinIO error: {e}")
    return {"message": "Object dihapus"}

@app.post("/storage/buckets/{bucket}/presign/upload", tags=["ObjectStorage"])
def presign_upload(bucket: str, body: PresignRequest,
                   user: User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    bucket_row = get_bucket_for_user(db, user, bucket)
    s3 = get_s3_client()
    try:
        url = s3.presigned_put_object(
            bucket_row.name,
            body.object_key,
            expires=timedelta(seconds=body.expiry_seconds),
        )
    except S3Error as e:
        raise HTTPException(400, f"S3 error: {e.code}")
    except Exception as e:
        raise HTTPException(502, f"MinIO error: {e}")
    return {
        "url": url,
        "method": "PUT",
        "expiry_seconds": body.expiry_seconds,
        "object_key": body.object_key,
    }

@app.post("/storage/buckets/{bucket}/presign/download", tags=["ObjectStorage"])
def presign_download(bucket: str, body: PresignRequest,
                     user: User = Depends(get_current_user),
                     db: Session = Depends(get_db)):
    bucket_row = get_bucket_for_user(db, user, bucket)
    s3 = get_s3_client()
    try:
        url = s3.presigned_get_object(
            bucket_row.name,
            body.object_key,
            expires=timedelta(seconds=body.expiry_seconds),
        )
    except S3Error as e:
        raise HTTPException(400, f"S3 error: {e.code}")
    except Exception as e:
        raise HTTPException(502, f"MinIO error: {e}")
    return {
        "url": url,
        "method": "GET",
        "expiry_seconds": body.expiry_seconds,
        "object_key": body.object_key,
    }

# ════════════════════════════════════════════════════════════
# MONITORING
# ════════════════════════════════════════════════════════════
@app.get("/monitoring/host", tags=["Monitoring"])
def host_metrics(admin: User = Depends(require_admin)):
    return get_engine().get_host_info()

@app.get("/monitoring/summary", tags=["Monitoring"])
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

# ════════════════════════════════════════════════════════════
# CATALOG & HEALTH
# ════════════════════════════════════════════════════════════
@app.get("/catalog/images", tags=["Catalog"])
def list_images():
    return {"images": list(AVAILABLE_IMAGES.keys())}

@app.get("/catalog/instance-types", tags=["Catalog"])
def list_types():
    return {"instance_types": INSTANCE_TYPES}

@app.get("/health", tags=["System"])
def health():
    return {"status": "ok", "service": "Miniatur IaaS", "time": datetime.utcnow().isoformat()}

@app.get("/", tags=["System"])
def root():
    return {"message": "Miniatur IaaS API", "docs": "/docs", "health": "/health"}
