from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from compute import get_engine
from config import PUBLIC_HOST
from database import get_db
from deps import get_current_user
from helpers import (
    allocate_floating_port,
    allocate_ssh_port,
    attach_floating_ip_to_instance,
    detach_floating_ip_from_instance,
    get_attached_floating_ip,
    get_default_network,
    get_floating_ip_for_user,
    get_network_for_user,
    get_security_group_for_user,
    recreate_instance_with_volumes,
    security_group_allows_port,
)
from models import (
    FloatingIP,
    Instance,
    InstanceStatus,
    Network,
    SecurityGroup,
    SecurityGroupRule,
    User,
)
from schemas import (
    FloatingIPAttach,
    FloatingIPCreate,
    InstanceNetworkUpdate,
    InstanceSecurityGroupUpdate,
    NetworkCreate,
    SecurityGroupCreate,
    SecurityGroupRuleCreate,
)

router = APIRouter(tags=["Network"])


# ── Instance network / security-group ────────────────────────
@router.post("/instances/{iid}/network")
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


@router.post("/instances/{iid}/security-group")
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


# ── Networks ──────────────────────────────────────────────────
@router.get("/networks")
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


@router.post("/networks", status_code=201)
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


@router.delete("/networks/{nid}")
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


# ── Security Groups ──────────────────────────────────────────
@router.get("/security-groups")
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


@router.post("/security-groups", status_code=201)
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


@router.delete("/security-groups/{sid}")
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


@router.post("/security-groups/{sid}/rules", status_code=201)
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


@router.delete("/security-groups/{sid}/rules/{rid}")
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


# ── Floating IPs ──────────────────────────────────────────────
@router.get("/floating-ips")
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


@router.post("/floating-ips", status_code=201)
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


@router.post("/floating-ips/{fid}/attach")
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


@router.post("/floating-ips/{fid}/detach")
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


@router.delete("/floating-ips/{fid}")
def release_floating_ip(fid: str, user: User = Depends(get_current_user),
                        db: Session = Depends(get_db)):
    fip = get_floating_ip_for_user(db, user, fid)
    if fip.instance_id:
        raise HTTPException(409, "Floating IP masih terpasang")
    db.delete(fip)
    db.commit()
    return {"message": "Floating IP dilepas"}
