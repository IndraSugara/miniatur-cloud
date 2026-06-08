"""RDS Engine — manages PostgreSQL container lifecycle for managed databases.

Each RDS database is a separate ``postgres:16-alpine`` container placed on
the user's chosen Docker network.  Data is persisted via a named Docker
volume so it survives container restarts.
"""

from __future__ import annotations

import logging
import secrets
import string
import time

import docker
from docker.types import IPAMConfig, IPAMPool

from compute import get_engine

log = logging.getLogger("iaas.rds")

# Docker image used for all RDS instances
RDS_IMAGE = "postgres:16-alpine"

# Resource limits per RDS container
RDS_MEM_LIMIT = 128 * 1024 * 1024   # 128 MB
RDS_NANO_CPUS = int(0.5 * 1e9)      # 0.5 vCPU


def _generate_password(length: int = 20) -> str:
    chars = string.ascii_letters + string.digits
    return "".join(secrets.choice(chars) for _ in range(length))


def _generate_db_identifier(db_id: str) -> str:
    """Create a safe PostgreSQL-compatible identifier from the UUID prefix."""
    return f"rds_{db_id[:8].replace('-', '')}"


def create_rds_container(
    db_id: str,
    db_name: str,
    db_user: str,
    db_password: str,
    owner_id: str,
    network_name: str,
) -> dict:
    """Spin up a new PostgreSQL container on the given Docker network.

    Returns dict with ``container_id``, ``ip_address``, ``volume_name``.
    """
    client = get_engine().client
    cname = f"rds-{db_id[:8]}"
    volume_name = f"rds-data-{db_id[:8]}"

    log.info(f"Creating RDS container {cname} | db={db_name} | net={network_name}")

    # Ensure image is available
    try:
        client.images.get(RDS_IMAGE)
    except docker.errors.ImageNotFound:
        log.info(f"Pulling RDS image {RDS_IMAGE}...")
        client.images.pull(RDS_IMAGE)

    container = client.containers.run(
        image=RDS_IMAGE,
        name=cname,
        detach=True,
        network=network_name,
        environment={
            "POSTGRES_DB": db_name,
            "POSTGRES_USER": db_user,
            "POSTGRES_PASSWORD": db_password,
        },
        volumes={volume_name: {"bind": "/var/lib/postgresql/data", "mode": "rw"}},
        mem_limit=RDS_MEM_LIMIT,
        nano_cpus=RDS_NANO_CPUS,
        labels={
            "iaas.rds_id": db_id,
            "iaas.owner_id": owner_id,
            "iaas.type": "rds",
            "iaas.db_name": db_name,
        },
        restart_policy={"Name": "unless-stopped"},
    )

    # Wait for container to be running
    for _ in range(10):
        container.reload()
        if container.status == "running":
            break
        time.sleep(0.5)

    # Get IP on the target network
    container.reload()
    networks = container.attrs["NetworkSettings"]["Networks"]
    ip = networks.get(network_name, {}).get("IPAddress", "")

    log.info(f"RDS container {cname} running at {ip}")

    return {
        "container_id": container.id,
        "ip_address": ip,
        "volume_name": volume_name,
    }


def wait_for_ready(container_id: str, timeout: int = 30) -> bool:
    """Poll pg_isready inside the container until PostgreSQL is accepting connections."""
    client = get_engine().client
    try:
        container = client.containers.get(container_id)
    except docker.errors.NotFound:
        return False

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            res = container.exec_run(
                ["pg_isready", "-U", "postgres"],
                stream=False,
            )
            if res.exit_code == 0:
                log.info(f"RDS container {container_id[:12]} is ready")
                return True
        except Exception:
            pass
        time.sleep(1)

    log.warning(f"RDS container {container_id[:12]} not ready after {timeout}s")
    return False


def stop_rds_container(container_id: str):
    """Stop a running RDS container."""
    client = get_engine().client
    try:
        c = client.containers.get(container_id)
        c.stop(timeout=15)
        log.info(f"RDS container {container_id[:12]} stopped")
    except docker.errors.NotFound:
        pass


def start_rds_container(container_id: str, network_name: str) -> str:
    """Start a stopped RDS container and return its new IP."""
    client = get_engine().client
    c = client.containers.get(container_id)
    c.start()

    # Wait for running
    for _ in range(10):
        c.reload()
        if c.status == "running":
            break
        time.sleep(0.5)

    c.reload()
    networks = c.attrs["NetworkSettings"]["Networks"]
    ip = networks.get(network_name, {}).get("IPAddress", "")
    if not ip and networks:
        ip = list(networks.values())[0].get("IPAddress", "")
    log.info(f"RDS container {container_id[:12]} started at {ip}")
    return ip


def restart_rds_container(container_id: str, network_name: str) -> str:
    """Restart an RDS container and return its new IP."""
    client = get_engine().client
    c = client.containers.get(container_id)
    c.restart(timeout=15)

    for _ in range(10):
        c.reload()
        if c.status == "running":
            break
        time.sleep(0.5)

    c.reload()
    networks = c.attrs["NetworkSettings"]["Networks"]
    ip = networks.get(network_name, {}).get("IPAddress", "")
    if not ip and networks:
        ip = list(networks.values())[0].get("IPAddress", "")
    return ip


def delete_rds_container(container_id: str, volume_name: str | None = None):
    """Stop, remove the container, and optionally remove the data volume."""
    client = get_engine().client
    try:
        c = client.containers.get(container_id)
        c.stop(timeout=10)
        c.remove(force=True)
        log.info(f"RDS container {container_id[:12]} removed")
    except docker.errors.NotFound:
        pass

    if volume_name:
        try:
            vol = client.volumes.get(volume_name)
            vol.remove(force=True)
            log.info(f"RDS volume {volume_name} removed")
        except docker.errors.NotFound:
            pass
        except Exception as e:
            log.warning(f"Failed to remove RDS volume {volume_name}: {e}")


def get_container_ip(container_id: str, network_name: str) -> str:
    """Get the IP of an RDS container on a specific network."""
    client = get_engine().client
    try:
        c = client.containers.get(container_id)
        c.reload()
        networks = c.attrs["NetworkSettings"]["Networks"]
        return networks.get(network_name, {}).get("IPAddress", "")
    except docker.errors.NotFound:
        return ""


def update_rds_password(container_id: str, db_user: str, new_password: str) -> bool:
    """Change the PostgreSQL role password inside the running container."""
    client = get_engine().client
    try:
        c = client.containers.get(container_id)
        # Use psql to alter the role password
        sql = f"ALTER USER {db_user} WITH PASSWORD '{new_password}';"
        res = c.exec_run(
            ["psql", "-U", db_user, "-c", sql],
            stream=False,
        )
        if res.exit_code == 0:
            log.info(f"RDS password updated for {db_user}")
            return True
        log.warning(f"RDS password update failed: {res.output.decode()[:200]}")
        return False
    except Exception as e:
        log.error(f"RDS password update error: {e}")
        return False


def add_port_mapping(container_id: str, host_port: int):
    """Recreate container with a published port for public access.

    Docker does not allow adding port mappings to a running container,
    so this is a destructive operation — we must recreate.  However,
    the data volume survives, so data is not lost.

    Returns the new container ID.
    """
    client = get_engine().client
    c = client.containers.get(container_id)
    c.reload()

    # Extract current config
    config = c.attrs["Config"]
    host_config = c.attrs["HostConfig"]
    networks = c.attrs["NetworkSettings"]["Networks"]
    labels = config.get("Labels", {})
    env = config.get("Env", [])
    image = config["Image"]
    name = c.name
    volumes = host_config.get("Binds") or []

    # Parse volume mounts
    volume_spec = {}
    for bind in volumes:
        parts = bind.split(":")
        if len(parts) >= 2:
            volume_spec[parts[0]] = {"bind": parts[1], "mode": parts[2] if len(parts) > 2 else "rw"}

    # Determine which network to reconnect to
    net_names = list(networks.keys())

    # Stop and remove old container
    c.stop(timeout=10)
    c.remove(force=True)

    # Create new container with port mapping
    new_container = client.containers.run(
        image=image,
        name=name,
        detach=True,
        environment=env,
        volumes=volume_spec,
        ports={"5432/tcp": host_port},
        mem_limit=RDS_MEM_LIMIT,
        nano_cpus=RDS_NANO_CPUS,
        labels=labels,
        restart_policy={"Name": "unless-stopped"},
    )

    # Reconnect to all original networks
    for net_name in net_names:
        if net_name == "bridge":
            continue
        try:
            net = client.networks.get(net_name)
            net.connect(new_container)
        except Exception as e:
            log.warning(f"Failed to reconnect {name} to {net_name}: {e}")

    # Disconnect from default bridge if we have other networks
    if net_names and "bridge" not in [n for n in net_names if n != "bridge"]:
        try:
            bridge = client.networks.get("bridge")
            bridge.disconnect(new_container, force=True)
        except Exception:
            pass

    # Wait for running
    for _ in range(10):
        new_container.reload()
        if new_container.status == "running":
            break
        time.sleep(0.5)

    log.info(f"RDS container recreated with port mapping :{host_port} -> :5432")
    return new_container.id


def remove_port_mapping(container_id: str):
    """Recreate container WITHOUT the published port.

    Returns the new container ID.
    """
    client = get_engine().client
    c = client.containers.get(container_id)
    c.reload()

    config = c.attrs["Config"]
    host_config = c.attrs["HostConfig"]
    networks = c.attrs["NetworkSettings"]["Networks"]
    labels = config.get("Labels", {})
    env = config.get("Env", [])
    image = config["Image"]
    name = c.name
    volumes = host_config.get("Binds") or []

    volume_spec = {}
    for bind in volumes:
        parts = bind.split(":")
        if len(parts) >= 2:
            volume_spec[parts[0]] = {"bind": parts[1], "mode": parts[2] if len(parts) > 2 else "rw"}

    net_names = [n for n in networks.keys() if n != "bridge"]

    c.stop(timeout=10)
    c.remove(force=True)

    # Determine the first user network to use as initial network
    initial_network = net_names[0] if net_names else None

    new_container = client.containers.run(
        image=image,
        name=name,
        detach=True,
        network=initial_network,
        environment=env,
        volumes=volume_spec,
        mem_limit=RDS_MEM_LIMIT,
        nano_cpus=RDS_NANO_CPUS,
        labels=labels,
        restart_policy={"Name": "unless-stopped"},
    )

    # Reconnect to remaining networks
    for net_name in net_names[1:]:
        try:
            net = client.networks.get(net_name)
            net.connect(new_container)
        except Exception as e:
            log.warning(f"Failed to reconnect {name} to {net_name}: {e}")

    for _ in range(10):
        new_container.reload()
        if new_container.status == "running":
            break
        time.sleep(0.5)

    log.info(f"RDS container recreated without port mapping")
    return new_container.id
