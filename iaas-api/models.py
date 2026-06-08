from sqlalchemy import Column, String, Integer, Float, DateTime, Boolean, Enum, Text, ForeignKey
from sqlalchemy.orm import declarative_base
from datetime import datetime, timezone
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
    created_at       = Column(DateTime, default=lambda: datetime.now(timezone.utc))

class Instance(Base):
    __tablename__ = "instances"
    id             = Column(String(36), primary_key=True)
    name           = Column(String(128), nullable=False)
    owner_id       = Column(String(36), ForeignKey("users.id"), nullable=False)
    owner_username = Column(String(64), nullable=False)
    status         = Column(Enum(InstanceStatus), default=InstanceStatus.PENDING)
    image          = Column(String(128), nullable=False)
    instance_type  = Column(String(32), nullable=False)
    vcpu           = Column(Float, default=0.5)
    memory_mb      = Column(Integer, default=256)
    network_id     = Column(String(36), ForeignKey("networks.id"), nullable=True)
    security_group_id = Column(String(36), ForeignKey("security_groups.id"), nullable=True)
    container_id   = Column(String(64), nullable=True)
    ip_address     = Column(String(15), nullable=True)
    ssh_port       = Column(Integer, nullable=True)
    ssh_password   = Column(String(32), nullable=True)
    # ── New fields ────────────────────────────────────────────────
    status_detail  = Column(String(256), nullable=True)   # provisioning stage
    error_message  = Column(Text, nullable=True)           # user-visible error
    tags           = Column(Text, nullable=True)           # JSON-serialized dict
    public_hostname = Column(String(256), nullable=True)   # e.g. my-web.app.sughara.my.id
    expose_port    = Column(Integer, nullable=True)        # port that is publicly exposed
    created_at     = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at     = Column(DateTime, default=lambda: datetime.now(timezone.utc))

class Network(Base):
    __tablename__ = "networks"
    id          = Column(String(36), primary_key=True)
    name        = Column(String(64), nullable=False)
    owner_id    = Column(String(36), ForeignKey("users.id"), nullable=False)
    cidr        = Column(String(32), nullable=True)
    gateway     = Column(String(32), nullable=True)
    docker_name = Column(String(128), nullable=False)
    is_default  = Column(Boolean, default=False)
    created_at  = Column(DateTime, default=lambda: datetime.now(timezone.utc))

class SecurityGroup(Base):
    __tablename__ = "security_groups"
    id          = Column(String(36), primary_key=True)
    name        = Column(String(64), nullable=False)
    owner_id    = Column(String(36), ForeignKey("users.id"), nullable=False)
    is_default  = Column(Boolean, default=False)
    created_at  = Column(DateTime, default=lambda: datetime.now(timezone.utc))

class SecurityGroupRule(Base):
    __tablename__ = "security_group_rules"
    id          = Column(String(36), primary_key=True)
    group_id    = Column(String(36), ForeignKey("security_groups.id"), nullable=False)
    direction   = Column(String(16), default="ingress")
    protocol    = Column(String(8), default="tcp")
    port_min    = Column(Integer, nullable=False)
    port_max    = Column(Integer, nullable=False)
    cidr        = Column(String(32), default="0.0.0.0/0")
    created_at  = Column(DateTime, default=lambda: datetime.now(timezone.utc))

class Snapshot(Base):
    __tablename__ = "snapshots"
    id                 = Column(String(36), primary_key=True)
    name               = Column(String(128), nullable=False)
    owner_id           = Column(String(36), ForeignKey("users.id"), nullable=False)
    source_instance_id = Column(String(36), ForeignKey("instances.id"), nullable=False)
    image_ref          = Column(String(256), nullable=False)
    created_at         = Column(DateTime, default=lambda: datetime.now(timezone.utc))

class ObjectBucket(Base):
    __tablename__ = "object_buckets"
    id         = Column(String(36), primary_key=True)
    name       = Column(String(63), unique=True, nullable=False)
    owner_id   = Column(String(36), ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

class PublicEndpoint(Base):
    """Formerly FloatingIP — renamed to set correct expectations.

    Each public endpoint is a host-port mapping (192.168.1.2:<port>)
    that forwards traffic to a container port.
    """
    __tablename__ = "public_endpoints"
    id           = Column(String(36), primary_key=True)
    owner_id     = Column(String(36), ForeignKey("users.id"), nullable=False)
    public_ip    = Column(String(64), nullable=False)
    public_port  = Column(Integer, nullable=False)
    instance_id  = Column(String(36), ForeignKey("instances.id"), nullable=True)
    status       = Column(String(32), default="available")
    created_at   = Column(DateTime, default=lambda: datetime.now(timezone.utc))

class Volume(Base):
    __tablename__ = "volumes"
    id         = Column(String(36), primary_key=True)
    name       = Column(String(128), nullable=False)
    owner_id   = Column(String(36), ForeignKey("users.id"), nullable=False)
    size_gb    = Column(Integer, nullable=False)
    host_path  = Column(String(512), nullable=True)
    status     = Column(String(32), default="available")
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

class VolumeAttachment(Base):
    __tablename__ = "volume_attachments"
    id          = Column(String(36), primary_key=True)
    volume_id   = Column(String(36), ForeignKey("volumes.id"), nullable=False)
    instance_id = Column(String(36), ForeignKey("instances.id"), nullable=False)
    mount_path  = Column(String(128), nullable=False)
    created_at  = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class DatabaseStatus(str, enum.Enum):
    CREATING  = "creating"
    AVAILABLE = "available"
    STOPPED   = "stopped"
    DELETING  = "deleting"
    ERROR     = "error"

class DatabaseInstance(Base):
    __tablename__ = "database_instances"
    id              = Column(String(36), primary_key=True)
    name            = Column(String(128), nullable=False)
    owner_id        = Column(String(36), ForeignKey("users.id"), nullable=False)
    owner_username  = Column(String(64), nullable=False)
    engine          = Column(String(32), default="postgresql-16")
    status          = Column(Enum(DatabaseStatus), default=DatabaseStatus.CREATING)
    db_name         = Column(String(64), nullable=False, unique=True)
    db_user         = Column(String(64), nullable=False)
    db_password     = Column(String(64), nullable=False)
    container_id    = Column(String(64), nullable=True)
    network_id      = Column(String(36), ForeignKey("networks.id"), nullable=True)
    ip_address      = Column(String(15), nullable=True)
    port            = Column(Integer, default=5432)
    volume_name     = Column(String(128), nullable=True)
    public_hostname = Column(String(256), nullable=True)
    expose_port     = Column(Integer, nullable=True)
    error_message   = Column(Text, nullable=True)
    created_at      = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at      = Column(DateTime, default=lambda: datetime.now(timezone.utc))
