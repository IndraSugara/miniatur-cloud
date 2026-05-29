from __future__ import annotations

import re
from pydantic import BaseModel, Field, field_validator
from typing import Optional, List, Dict


class UserRegister(BaseModel):
    username: str = Field(..., min_length=3, max_length=32)
    email:    str
    password: str = Field(..., min_length=8)

    @field_validator("password")
    @classmethod
    def strong_password(cls, v: str) -> str:
        if not re.search(r"[A-Z]", v):
            raise ValueError("Password harus mengandung minimal 1 huruf besar")
        if not re.search(r"[0-9]", v):
            raise ValueError("Password harus mengandung minimal 1 angka")
        return v


class InstanceCreate(BaseModel):
    name          : str = Field(..., min_length=2, max_length=64)
    image         : str = Field(default="ubuntu-22.04")
    instance_type : str = Field(default="nano.small")
    network_id    : Optional[str] = None
    volume_ids    : Optional[List[str]] = None
    security_group_id: Optional[str] = None
    public_endpoint_id: Optional[str] = None
    tags          : Optional[Dict[str, str]] = None


class InstanceAction(BaseModel):
    action: str  # start | stop | reboot | terminate


class InstanceTagsUpdate(BaseModel):
    tags: Dict[str, str] = Field(default_factory=dict)


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


class PublicEndpointCreate(BaseModel):
    instance_id: Optional[str] = None


class PublicEndpointAttach(BaseModel):
    instance_id: str


class BucketCreate(BaseModel):
    name: Optional[str] = Field(None, min_length=3, max_length=63)


class PresignRequest(BaseModel):
    object_key: str = Field(..., min_length=1, max_length=1024)
    expiry_seconds: int = Field(default=3600, ge=60, le=604800)
