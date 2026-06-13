"""Service layer for Prometheus and Loki queries with user-scoped filtering."""

import logging
from typing import Optional

from httpx import AsyncClient

log = logging.getLogger("iaas.monitoring")

PROMETHEUS_URL = "http://cloud-metrics:9090"
LOKI_URL = "http://cloud-logs:3100"

# ── Prometheus PromQL builders (user-scoped) ──────────────────

def _instance_cpu_query(owner_id: str, instance_id: str) -> str:
    """CPU usage (percentage) for a single instance container."""
    return (
        'sum(rate(container_cpu_usage_seconds_total{'
        f'container_label_iaas_owner_id="{owner_id}",'
        f'container_label_iaas_instance_id="{instance_id}"'
        '}[1m])) by (container_label_iaas_instance_name) * 100'
    )


def _instance_mem_query(owner_id: str, instance_id: str) -> str:
    """Memory usage bytes for a single instance container."""
    return (
        'container_memory_working_set_bytes{'
        f'container_label_iaas_owner_id="{owner_id}",'
        f'container_label_iaas_instance_id="{instance_id}"'
        '}'
    )


def _instance_net_rx_query(owner_id: str, instance_id: str) -> str:
    """Network receive bytes/sec for a single instance."""
    return (
        'sum(rate(container_network_receive_bytes_total{'
        f'container_label_iaas_owner_id="{owner_id}",'
        f'container_label_iaas_instance_id="{instance_id}"'
        '}[1m])) by (container_label_iaas_instance_name)'
    )


def _instance_net_tx_query(owner_id: str, instance_id: str) -> str:
    """Network transmit bytes/sec for a single instance."""
    return (
        'sum(rate(container_network_transmit_bytes_total{'
        f'container_label_iaas_owner_id="{owner_id}",'
        f'container_label_iaas_instance_id="{instance_id}"'
        '}[1m])) by (container_label_iaas_instance_name)'
    )


def _instance_disk_query(owner_id: str, instance_id: str) -> str:
    """Filesystem usage bytes for a single instance container."""
    return (
        'container_fs_usage_bytes{'
        f'container_label_iaas_owner_id="{owner_id}",'
        f'container_label_iaas_instance_id="{instance_id}"'
        '}'
    )


# ── HTTP query helpers ────────────────────────────────────────

async def query_prometheus(
    query: str,
    time_range: Optional[tuple] = None,
) -> dict:
    """Execute a Prometheus instant or range query."""
    async with AsyncClient(base_url=PROMETHEUS_URL, timeout=10.0) as client:
        if time_range:
            start, end, step = time_range
            params = {"query": query, "start": start, "end": end, "step": step}
            resp = await client.get("/api/v1/query_range", params=params)
        else:
            params = {"query": query}
            resp = await client.get("/api/v1/query", params=params)
        resp.raise_for_status()
        data = resp.json()
        if data.get("status") != "success":
            log.warning("Prometheus query warning: %s", data.get("error", "unknown"))
        return data


async def query_loki(
    logql: str,
    start_ns: int,
    end_ns: int,
    limit: int = 100,
) -> dict:
    """Execute a Loki range query."""
    async with AsyncClient(base_url=LOKI_URL, timeout=10.0) as client:
        params = {
            "query": logql,
            "start": start_ns,
            "end": end_ns,
            "limit": limit,
            "direction": "backward",
        }
        resp = await client.get("/loki/api/v1/query_range", params=params)
        resp.raise_for_status()
        return resp.json()


# ── Loki LogQL builder ────────────────────────────────────────

def _build_loki_query(
    owner_id: str,
    instance_id: str,
    search: Optional[str] = None,
) -> str:
    """Build a LogQL query with owner and instance label matchers."""
    query = f'{{owner_id="{owner_id}", instance_id="{instance_id}"}}'
    if search:
        # Escape double quotes in search string
        safe = search.replace("\\", "\\\\").replace('"', '\\"')
        query += f' |= "{safe}"'
    return query


# ── Result extractors ─────────────────────────────────────────

async def get_instant_metric(query: str) -> Optional[float]:
    """Extract a single float value from a Prometheus instant query."""
    result = await query_prometheus(query)
    results = result.get("data", {}).get("result", [])
    if results and len(results[0].get("value", [])) >= 2:
        try:
            return float(results[0]["value"][1])
        except (ValueError, IndexError, TypeError):
            return None
    return None


async def get_range_metric(
    query: str,
    start: str,
    end: str,
    step: str = "15s",
):
    """Return datapoints [[timestamp, value], ...] from a range query."""
    result = await query_prometheus(query, time_range=(start, end, step))
    results = result.get("data", {}).get("result", [])
    if results:
        return results[0].get("values", [])
    return []
