from sqlalchemy import Column, String, Integer, Float, DateTime, Boolean, Enum, Text
from sqlalchemy.orm import declarative_base
from datetime import datetime
import enum

Base = declarative_base()

class InstanceStatus(str, enum.Enum):
    PENDING    = "pending"
    RUNNING    = "running"
    STOPPED    = "stopped"
    TERMINATED = "terminated"
    ERROR      = "error"

class User(Base):
    __tablename__ = "users"
    id               = Column(String(36), primary_key=True)
    username         = Column(String(64), unique=True, nullable=False)
    email            = Column(String(128), unique=True, nullable=False)
    hashed_password  = Column(String(256), nullable=False)
    is_admin         = Column(Boolean, default=False)
    is_active        = Column(Boolean, default=True)
    quota_instances  = Column(Integer, default=3)
    created_at       = Column(DateTime, default=datetime.utcnow)

class Instance(Base):
    __tablename__ = "instances"
    id             = Column(String(36), primary_key=True)
    name           = Column(String(128), nullable=False)
    owner_id       = Column(String(36), nullable=False)
    owner_username = Column(String(64), nullable=False)
    status         = Column(Enum(InstanceStatus), default=InstanceStatus.PENDING)
    image          = Column(String(128), nullable=False)
    instance_type  = Column(String(32), nullable=False)
    vcpu           = Column(Float, default=0.5)
    memory_mb      = Column(Integer, default=256)
    container_id   = Column(String(64), nullable=True)
    ip_address     = Column(String(15), nullable=True)
    ssh_port       = Column(Integer, nullable=True)
    ssh_password   = Column(String(32), nullable=True)
    created_at     = Column(DateTime, default=datetime.utcnow)
    updated_at     = Column(DateTime, default=datetime.utcnow)

class Volume(Base):
    __tablename__ = "volumes"
    id         = Column(String(36), primary_key=True)
    name       = Column(String(128), nullable=False)
    owner_id   = Column(String(36), nullable=False)
    size_gb    = Column(Integer, nullable=False)
    host_path  = Column(String(512), nullable=True)
    status     = Column(String(32), default="available")
    created_at = Column(DateTime, default=datetime.utcnow)
