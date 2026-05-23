import docker
import uuid
import logging
import time

log = logging.getLogger("iaas.compute")

DOCKER_NETWORK = "miniatur-cloud_cloud-net"

INSTANCE_TYPES = {
    "nano.micro" : {"vcpu": 0.25, "memory_mb": 128},
    "nano.small" : {"vcpu": 0.5,  "memory_mb": 256},
    "nano.medium": {"vcpu": 1.0,  "memory_mb": 512},
    "nano.large" : {"vcpu": 2.0,  "memory_mb": 1024},
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
        used_ports = set()
        for c in self.client.containers.list(all=True, filters={"label": "iaas.instance_id"}):
            p = c.labels.get("iaas.ssh_port")
            if p:
                used_ports.add(int(p))
        port = SSH_PORT_START + 1
        while port in used_ports:
            port += 1
        return port

    def create_instance(self, name, image_key, vcpu, memory_mb, owner_id) -> dict:
        iid       = str(uuid.uuid4())
        cname     = f"iaas-{iid[:8]}"
        image     = AVAILABLE_IMAGES.get(image_key, image_key)
        ssh_port  = self._next_ssh_port()
        password  = _generate_password()
        nano_cpus = int(vcpu * 1e9)
        mem_bytes = memory_mb * 1024 * 1024

        log.info(f"Membuat instance {cname} | {image} | ssh_port={ssh_port}")

        try:
            container = self.client.containers.run(
                image=image,
                name=cname,
                detach=True,
                network=DOCKER_NETWORK,
                nano_cpus=nano_cpus,
                mem_limit=mem_bytes,
                ports={"22/tcp": ssh_port},
                stdin_open=True,
                tty=True,
                restart_policy={"Name": "unless-stopped"},
                labels={
                    "iaas.instance_id": iid,
                    "iaas.owner_id"   : owner_id,
                    "iaas.name"       : name,
                    "iaas.ssh_port"   : str(ssh_port),
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
            ip = networks.get(DOCKER_NETWORK, {}).get("IPAddress", "")

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
            return self.create_instance(name, image_key, vcpu, memory_mb, owner_id)

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

    def terminate_instance(self, container_id):
        try:
            c = self.client.containers.get(container_id)
            c.stop(timeout=5)
            c.remove(force=True)
        except docker.errors.NotFound:
            pass

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
        return {
            "cpu_count"      : psutil.cpu_count(),
            "cpu_percent"    : psutil.cpu_percent(interval=0.5),
            "memory_total_gb": round(psutil.virtual_memory().total / 1e9, 2),
            "memory_used_gb" : round(psutil.virtual_memory().used  / 1e9, 2),
            "memory_percent" : psutil.virtual_memory().percent,
            "disk_total_gb"  : round(psutil.disk_usage("/").total / 1e9, 2),
            "disk_free_gb"   : round(psutil.disk_usage("/").free  / 1e9, 2),
        }

_engine = None
def get_engine() -> ComputeEngine:
    global _engine
    if _engine is None:
        _engine = ComputeEngine()
    return _engine
