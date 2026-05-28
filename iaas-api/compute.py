import docker
import uuid
import logging
import time
from docker.types import IPAMConfig, IPAMPool

log = logging.getLogger("iaas.compute")

DOCKER_NETWORK = "miniatur-cloud_cloud-net"

INSTANCE_TYPES = {
    "nano.micro" : {"vcpu": 0.25, "memory_mb": 128},
    "nano.small" : {"vcpu": 0.5,  "memory_mb": 256},
    "nano.medium": {"vcpu": 1.0,  "memory_mb": 512},
    "nano.large" : {"vcpu": 2.0,  "memory_mb": 1024},
    "nano.xlarge": {"vcpu": 2.0,  "memory_mb": 2048},
    "nano.nlp"   : {"vcpu": 2.0,  "memory_mb": 1536},
}

AVAILABLE_IMAGES = {
    "ubuntu-22.04": "ubuntu:22.04",
    "ubuntu-20.04": "ubuntu:20.04",
    "alpine-3.18" : "alpine:3.18",
    "debian-12"   : "debian:12-slim",
    "nginx"       : "nginx:alpine",
}

SSH_PORT_START = 2200

# Script setup SSH per distro
SSH_SETUP = {
    "ubuntu": """
apt-get update -qq &&
apt-get install -y -qq openssh-server &&
mkdir -p /var/run/sshd &&
echo 'root:{password}' | chpasswd &&
sed -i 's/#PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config &&
sed -i 's/#PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config &&
sed -i 's/PasswordAuthentication no/PasswordAuthentication yes/' /etc/ssh/sshd_config &&
service ssh start || /usr/sbin/sshd
""",
    "debian": """
apt-get update -qq &&
apt-get install -y -qq openssh-server &&
mkdir -p /var/run/sshd &&
echo 'root:{password}' | chpasswd &&
sed -i 's/#PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config &&
sed -i 's/#PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config &&
service ssh start || /usr/sbin/sshd
""",
    "alpine": """
apk add --no-cache openssh &&
ssh-keygen -A &&
echo 'root:{password}' | chpasswd &&
sed -i 's/#PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config &&
sed -i 's/#PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config &&
/usr/sbin/sshd
""",
}

def _get_ssh_script(image_key: str, password: str) -> str:
    if "alpine" in image_key:
        script = SSH_SETUP["alpine"]
    elif "debian" in image_key:
        script = SSH_SETUP["debian"]
    else:
        script = SSH_SETUP["ubuntu"]
    return script.replace("{password}", password).strip()

def _generate_password() -> str:
    import random, string
    chars = string.ascii_letters + string.digits
    return ''.join(random.choices(chars, k=12))

class ComputeEngine:
    def __init__(self):
        self.client = docker.from_env()
        log.info("Docker client terhubung")

    def _next_ssh_port(self) -> int:
        return self.next_ssh_port()

    def next_ssh_port(self, reserved_ports=None) -> int:
        used_ports = set()
        for c in self.client.containers.list(all=True, filters={"label": "iaas.instance_id"}):
            p = c.labels.get("iaas.ssh_port")
            if p:
                used_ports.add(int(p))
        if reserved_ports:
            used_ports.update(reserved_ports)
        port = SSH_PORT_START + 1
        while port in used_ports:
            port += 1
        return port

    def create_instance(
        self,
        name,
        image_key,
        vcpu,
        memory_mb,
        owner_id,
        instance_id=None,
        network_name=None,
        ssh_port=None,
        ssh_password=None,
        volume_mounts=None,
        published_ports=None,
    ) -> dict:
        iid       = instance_id or str(uuid.uuid4())
        cname     = f"iaas-{iid[:8]}"
        image     = AVAILABLE_IMAGES.get(image_key, image_key)
        ssh_port  = ssh_port
        password  = ssh_password or _generate_password()
        nano_cpus = int(vcpu * 1e9)
        mem_bytes = memory_mb * 1024 * 1024
        net_name  = network_name or DOCKER_NETWORK

        volume_spec = None
        if volume_mounts:
            volume_spec = {}
            for mount in volume_mounts:
                vol_name = mount.get("volume_name")
                mount_path = mount.get("mount_path")
                if vol_name and mount_path:
                    volume_spec[vol_name] = {"bind": mount_path, "mode": "rw"}

        ports_spec = None
        if published_ports is not None:
            ports_spec = published_ports
        elif ssh_port:
            ports_spec = {"22/tcp": ssh_port}

        log.info(f"Membuat instance {cname} | {image} | ssh_port={ssh_port} | net={net_name}")

        try:
            container = self.client.containers.run(
                image=image,
                name=cname,
                detach=True,
                network=net_name,
                nano_cpus=nano_cpus,
                mem_limit=mem_bytes,
                ports=ports_spec,
                volumes=volume_spec,
                stdin_open=True,
                tty=True,
                restart_policy={"Name": "unless-stopped"},
                labels={
                    "iaas.instance_id": iid,
                    "iaas.owner_id"   : owner_id,
                    "iaas.name"       : name,
                    **({"iaas.ssh_port": str(ssh_port)} if ssh_port else {}),
                },
                command="/bin/sh" if "alpine" in image_key else "/bin/bash",
            )

            # Tunggu container benar-benar running
            time.sleep(2)
            container.reload()

            # Auto-setup SSH
            log.info(f"Setup SSH di {cname}...")
            ssh_script = _get_ssh_script(image_key, password)
            result = container.exec_run(
                ["/bin/sh", "-c", ssh_script],
                stream=False
            )
            if result.exit_code != 0:
                log.warning(f"SSH setup warning: {result.output.decode()[:200]}")
            else:
                log.info(f"SSH siap di {cname} port {ssh_port}")

            # Ambil IP
            container.reload()
            networks = container.attrs["NetworkSettings"]["Networks"]
            ip = networks.get(net_name, {}).get("IPAddress", "")

            return {
                "instance_id" : iid,
                "container_id": container.id,
                "ip_address"  : ip,
                "ssh_port"    : ssh_port,
                "ssh_password": password,
                "status"      : "running",
            }

        except docker.errors.ImageNotFound:
            log.info(f"Pull image {image}...")
            self.client.images.pull(image)
            return self.create_instance(
                name,
                image_key,
                vcpu,
                memory_mb,
                owner_id,
                instance_id=instance_id,
                network_name=network_name,
                ssh_port=ssh_port,
                ssh_password=ssh_password,
                volume_mounts=volume_mounts,
                published_ports=published_ports,
            )

        except Exception as e:
            log.error(f"Gagal buat instance: {e}")
            raise RuntimeError(str(e))

    def get_status(self, container_id: str) -> dict:
        try:
            c     = self.client.containers.get(container_id)
            stats = c.stats(stream=False)
            cpu_d = stats["cpu_stats"]["cpu_usage"]["total_usage"] - \
                    stats["precpu_stats"]["cpu_usage"]["total_usage"]
            sys_d = stats["cpu_stats"]["system_cpu_usage"] - \
                    stats["precpu_stats"]["system_cpu_usage"]
            ncpu  = stats["cpu_stats"].get("online_cpus", 1)
            cpu_pct = round((cpu_d / sys_d) * ncpu * 100, 2) if sys_d > 0 else 0
            mem_use = stats["memory_stats"].get("usage", 0)
            mem_lim = stats["memory_stats"].get("limit", 1)
            return {
                "status"      : c.status,
                "cpu_percent" : cpu_pct,
                "mem_usage_mb": round(mem_use / 1024 / 1024, 1),
                "mem_limit_mb": round(mem_lim / 1024 / 1024, 1),
            }
        except docker.errors.NotFound:
            return {"status": "terminated"}
        except Exception as e:
            return {"status": "error", "detail": str(e)}

    def start_instance(self, container_id):
        self.client.containers.get(container_id).start()

    def stop_instance(self, container_id):
        self.client.containers.get(container_id).stop(timeout=10)

    def restart_instance(self, container_id):
        self.client.containers.get(container_id).restart(timeout=10)

    def terminate_instance(self, container_id):
        try:
            c = self.client.containers.get(container_id)
            c.stop(timeout=5)
            c.remove(force=True)
        except docker.errors.NotFound:
            pass

    def recreate_instance(
        self,
        container_id,
        name,
        image_key,
        vcpu,
        memory_mb,
        owner_id,
        instance_id,
        network_name,
        ssh_port,
        ssh_password,
        volume_mounts,
        published_ports=None,
    ) -> dict:
        if container_id:
            try:
                c = self.client.containers.get(container_id)
                c.stop(timeout=5)
                c.remove(force=True)
            except docker.errors.NotFound:
                pass
        return self.create_instance(
            name,
            image_key,
            vcpu,
            memory_mb,
            owner_id,
            instance_id=instance_id,
            network_name=network_name,
            ssh_port=ssh_port,
            ssh_password=ssh_password,
            volume_mounts=volume_mounts,
            published_ports=published_ports,
        )

    def create_network(self, name, subnet_cidr=None, gateway=None) -> dict:
        ipam_pool = IPAMPool(subnet=subnet_cidr, gateway=gateway) if subnet_cidr else None
        ipam_cfg = IPAMConfig(pool_configs=[ipam_pool]) if ipam_pool else None
        net = self.client.networks.create(
            name=name,
            driver="bridge",
            ipam=ipam_cfg,
            labels={"iaas.network": "true"},
        )
        return {"id": net.id, "name": net.name, "subnet": subnet_cidr, "gateway": gateway}

    def inspect_network(self, name_or_id) -> dict:
        net = self.client.networks.get(name_or_id)
        ipam = net.attrs.get("IPAM", {})
        cfg = ipam.get("Config", [])
        subnet = cfg[0].get("Subnet") if cfg else None
        gateway = cfg[0].get("Gateway") if cfg else None
        return {"id": net.id, "name": net.name, "subnet": subnet, "gateway": gateway}

    def remove_network(self, name_or_id):
        net = self.client.networks.get(name_or_id)
        net.remove()

    def connect_network(self, container_id, network_name):
        net = self.client.networks.get(network_name)
        c = self.client.containers.get(container_id)
        net.connect(c)

    def disconnect_network(self, container_id, network_name):
        net = self.client.networks.get(network_name)
        c = self.client.containers.get(container_id)
        net.disconnect(c, force=True)

    def get_container_network_ip(self, container_id, network_name) -> str:
        c = self.client.containers.get(container_id)
        c.reload()
        networks = c.attrs["NetworkSettings"]["Networks"]
        return networks.get(network_name, {}).get("IPAddress", "")

    def create_volume(self, name) -> str:
        vol = self.client.volumes.create(name=name, labels={"iaas.volume": "true"})
        return vol.name

    def remove_volume(self, name):
        vol = self.client.volumes.get(name)
        vol.remove(force=True)

    def create_snapshot(self, container_id, image_repo, tag="latest") -> dict:
        image = self.client.images.commit(container=container_id, repository=image_repo, tag=tag)
        image_ref = f"{image_repo}:{tag}"
        return {"image_id": image.id, "image_ref": image_ref}

    def remove_image(self, image_ref):
        self.client.images.remove(image=image_ref, force=False)

    def exec_command(self, container_id, command):
        c   = self.client.containers.get(container_id)
        res = c.exec_run(command, stream=False, demux=True)
        return {
            "exit_code": res.exit_code,
            "stdout"   : res.output[0].decode() if res.output[0] else "",
            "stderr"   : res.output[1].decode() if res.output[1] else "",
        }

    def get_host_info(self):
        import psutil
        import os
        vm = psutil.virtual_memory()
        disk = psutil.disk_usage("/")
        load_avg = os.getloadavg() if hasattr(os, "getloadavg") else (0.0, 0.0, 0.0)
        return {
            "cpu_count"      : psutil.cpu_count(),
            "cpu_percent"    : psutil.cpu_percent(interval=0.5),
            "memory_total_gb": round(vm.total / 1e9, 2),
            "memory_used_gb" : round(vm.used  / 1e9, 2),
            "memory_percent" : vm.percent,
            "disk_total_gb"  : round(disk.total / 1e9, 2),
            "disk_free_gb"   : round(disk.free  / 1e9, 2),
            "disk_used_gb"   : round((disk.total - disk.free) / 1e9, 2),
            "disk_percent"   : disk.percent,
            "load_avg"       : load_avg,
            "memory_total"   : vm.total,
            "memory_used"    : vm.used,
            "disk_total"     : disk.total,
            "disk_used"      : disk.total - disk.free,
        }

_engine = None
def get_engine() -> ComputeEngine:
    global _engine
    if _engine is None:
        _engine = ComputeEngine()
    return _engine
