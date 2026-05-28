from __future__ import annotations

import re
import uuid
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from minio.error import S3Error
from sqlalchemy.orm import Session

from compute import get_engine
from database import get_db
from deps import get_current_user
from helpers import (
    get_bucket_for_user,
    get_default_network,
    get_s3_client,
    normalize_bucket_name,
    recreate_instance_with_volumes,
)
from models import (
    Instance,
    InstanceStatus,
    Network,
    ObjectBucket,
    User,
    Volume,
    VolumeAttachment,
)
from schemas import BucketCreate, PresignRequest, VolumeAttach, VolumeCreate, VolumeDetach

router = APIRouter(tags=["Storage"])


# ── Volumes ──────────────────────────────────────────────────
@router.get("/volumes")
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


@router.post("/volumes", status_code=201)
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


@router.delete("/volumes/{vid}")
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


@router.post("/volumes/{vid}/attach")
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


@router.post("/volumes/{vid}/detach")
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


# ── Object Storage (S3-like) ─────────────────────────────────
@router.get("/storage/buckets", tags=["ObjectStorage"])
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


@router.post("/storage/buckets", status_code=201, tags=["ObjectStorage"])
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


@router.delete("/storage/buckets/{bucket}", tags=["ObjectStorage"])
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


@router.get("/storage/buckets/{bucket}/objects", tags=["ObjectStorage"])
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


@router.delete("/storage/buckets/{bucket}/objects", tags=["ObjectStorage"])
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


@router.post("/storage/buckets/{bucket}/presign/upload", tags=["ObjectStorage"])
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


@router.post("/storage/buckets/{bucket}/presign/download", tags=["ObjectStorage"])
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
