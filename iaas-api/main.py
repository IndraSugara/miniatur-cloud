from fastapi import FastAPI, Depends, HTTPException, status, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime, timedelta
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session
from models import Base, User, Instance, Volume, InstanceStatus
from compute import get_engine, INSTANCE_TYPES, AVAILABLE_IMAGES
import uuid, os, logging, psutil

# ── Config ───────────────────────────────────────────────────
SECRET_KEY   = os.getenv("SECRET_KEY", "iaas-jetson-secret-ganti-ini")
ALGORITHM    = "HS256"
TOKEN_EXPIRE = 60
DB_URL       = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./iaas.db")
DB_SYNC_URL  = DB_URL.replace("aiosqlite", "pysqlite").replace("+aiosqlite", "")

logging.basicConfig(level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")
log = logging.getLogger("iaas.api")

# ── Database ─────────────────────────────────────────────────
engine  = create_engine(DB_SYNC_URL, connect_args={"check_same_thread": False})
Session = sessionmaker(bind=engine)
Base.metadata.create_all(engine)

def get_db():
    db = Session()
    try:
        yield db
    finally:
        db.close()

# ── Auth ──────────────────────────────────────────────────────
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

class InstanceAction(BaseModel):
    action: str  # start | stop | reboot | terminate

class ExecCommand(BaseModel):
    command: str

class VolumeCreate(BaseModel):
    name    : str
    size_gb : int = Field(default=2, ge=1, le=20)

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
    db = Session()
    if not db.query(User).filter(User.username == "admin").first():
        admin = User(
            id=str(uuid.uuid4()), username="admin",
            email="admin@iaas.local",
            hashed_password=hash_password("admin123"),
            is_admin=True, quota_instances=10,
        )
        db.add(admin)
        db.commit()
        log.info("Admin default dibuat: admin / admin123")
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

# ════════════════════════════════════════════════════════════
# INSTANCES (Compute)
# ════════════════════════════════════════════════════════════
@app.get("/instances", tags=["Compute"])
def list_instances(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    q = db.query(Instance)
    if not user.is_admin:
        q = q.filter(Instance.owner_id == user.id)
    instances = q.all()
    return {"instances": [
        {"id": i.id, "name": i.name, "status": i.status,
         "image": i.image, "instance_type": i.instance_type,
         "ip_address": i.ip_address, "ssh_port": i.ssh_port,
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

    if body.image not in AVAILABLE_IMAGES:
        raise HTTPException(400, f"Image tidak tersedia. Pilihan: {list(AVAILABLE_IMAGES.keys())}")
    if body.instance_type not in INSTANCE_TYPES:
        raise HTTPException(400, f"Tipe tidak ada. Pilihan: {list(INSTANCE_TYPES.keys())}")

    itype = INSTANCE_TYPES[body.instance_type]
    iid   = str(uuid.uuid4())

    inst = Instance(
        id=iid, name=body.name, owner_id=user.id,
        owner_username=user.username, image=body.image,
        instance_type=body.instance_type,
        vcpu=itype["vcpu"], memory_mb=itype["memory_mb"],
        status=InstanceStatus.PENDING,
    )
    db.add(inst); db.commit()

    bg.add_task(_create_container, iid, body, itype, user.id)
    return {"message": "Instance sedang dibuat", "instance_id": iid, "status": "pending"}

def _create_container(iid, body, itype, owner_id):
    db = Session()
    try:
        result = get_engine().create_instance(
            name=body.name, image_key=body.image,
            vcpu=itype["vcpu"], memory_mb=itype["memory_mb"],
            owner_id=owner_id,
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
        inst.status = InstanceStatus.ERROR
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
    return {"id": inst.id, "name": inst.name, "status": inst.status,
            "image": inst.image, "instance_type": inst.instance_type,
            "vcpu": inst.vcpu, "memory_mb": inst.memory_mb,
            "ip_address": inst.ip_address, "ssh_port": inst.ssh_port,
            "ssh_command": f"ssh root@192.168.1.2 -p {inst.ssh_port}" if inst.ssh_port else None,
            "ssh_password": inst.ssh_password,
            "created_at": str(inst.created_at)}

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
    elif action == "terminate":
        eng.terminate_instance(inst.container_id)
        inst.status = InstanceStatus.TERMINATED
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

# ════════════════════════════════════════════════════════════
# MONITORING
# ════════════════════════════════════════════════════════════
@app.get("/monitoring/host", tags=["Monitoring"])
def host_metrics(user: User = Depends(get_current_user)):
    return get_engine().get_host_info()

@app.get("/monitoring/summary", tags=["Monitoring"])
def summary(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    running   = db.query(Instance).filter(Instance.status == "running").count()
    stopped   = db.query(Instance).filter(Instance.status == "stopped").count()
    total     = db.query(Instance).count()
    users     = db.query(User).count()
    return {"instances": {"running": running, "stopped": stopped, "total": total},
            "users": users}

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
