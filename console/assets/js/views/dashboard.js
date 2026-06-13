import { REFRESH_MS } from "../config.js";
import {
  clampPercent,
  escapeHtml,
  statusClass,
  toLocalDate,
} from "../utils.js";

export const dashboardView = {
  id: "dashboard",
  title: "Dashboard",
  subtitle: "Ringkasan resource cloud per workspace.",
  async mount(root, { apis, navigate, state, refreshWorkspaces }) {
    const activeWs = state.activeWorkspace;

    root.innerHTML = `
      <div class="grid grid-4" id="stat-cards">
        <div class="stat-card">
          <div class="stat-icon compute"><img src="/assets/icons/server-dan-instance.png" alt="" width="22" height="22" /></div>
          <div class="stat-body">
            <div class="stat-value" id="s-instances">-</div>
            <div class="stat-label">Instances</div>
            <div class="stat-detail" id="s-instances-detail">-</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon database"><img src="/assets/icons/database.png" alt="" width="22" height="22" /></div>
          <div class="stat-body">
            <div class="stat-value" id="s-databases">-</div>
            <div class="stat-label">Databases</div>
            <div class="stat-detail" id="s-databases-detail">-</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon storage"><img src="/assets/icons/storage.png" alt="" width="22" height="22" /></div>
          <div class="stat-body">
            <div class="stat-value" id="s-buckets">-</div>
            <div class="stat-label">Buckets</div>
            <div class="stat-detail" id="s-buckets-detail">Object storage</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon network"><img src="/assets/icons/network.png" alt="" width="22" height="22" /></div>
          <div class="stat-body">
            <div class="stat-value" id="s-networks">-</div>
            <div class="stat-label">Networks</div>
            <div class="stat-detail" id="s-networks-detail">-</div>
          </div>
        </div>
      </div>

      <div class="grid grid-3" id="host-metrics-row">
        <div class="metric">
          <div class="label">CPU Host</div>
          <div id="m-cpu" class="value">-</div>
          <div class="progress"><span id="p-cpu" style="width:0%"></span></div>
        </div>
        <div class="metric">
          <div class="label">Memory Host</div>
          <div id="m-mem" class="value">-</div>
          <div id="m-mem-sub" class="hint">-</div>
          <div class="progress"><span id="p-mem" style="width:0%"></span></div>
        </div>
        <div class="metric">
          <div class="label">Disk Host</div>
          <div id="m-disk" class="value">-</div>
          <div id="m-disk-sub" class="hint">-</div>
          <div class="progress"><span id="p-disk" style="width:0%"></span></div>
        </div>
      </div>

      ${state.user?.is_admin ? `
      <section class="panel" id="dashboard-grafana-panel">
        <div class="panel-header">
          <h3>Host Dashboards</h3>
          <button id="dash-grafana-open" class="btn btn-inline btn-ghost">Open Grafana &nearr;</button>
        </div>
        <div style="border-radius:var(--radius-sm);overflow:hidden;border:1px solid var(--border);">
          <iframe id="dash-grafana-frame" src="/monitor/d/node-metrics?kiosk&theme=light&refresh=30s"
            style="width:100%;height:380px;border:none;background:var(--bg-surface);"
            loading="lazy"></iframe>
        </div>
        <p class="muted" style="margin-top:6px;font-size:11px;">
          CPU • Memory • Load • Disk • Network — auto-refresh 30s
        </p>
      </section>
      ` : ""}

      <section class="panel" id="instance-metrics-panel">
        <div class="panel-header">
          <h3>Running Instances</h3>
          <button class="btn btn-inline btn-ghost" data-nav="monitoring">Full Monitoring →</button>
        </div>
        <div id="instance-metrics-content">
          <span class="dim"><span class="spinner"></span> Loading metrics...</span>
        </div>
      </section>

      <div class="grid grid-2">
        <section class="panel" id="workspaces-panel">
          <div class="panel-header">
            <h3>${activeWs ? "Workspace Resources" : "Workspaces"}</h3>
            ${!activeWs ? `<button class="btn btn-inline" data-nav="network">Manage</button>` : ""}
          </div>
          <div id="workspaces-content"><span class="dim"><span class="spinner"></span> Memuat...</span></div>
        </section>

        <section class="panel" id="health-panel">
          <div class="panel-header">
            <h3>Service Health</h3>
          </div>
          <div id="health-box" class="dim"><span class="spinner"></span> Memuat...</div>
        </section>
      </div>

      <section class="panel" id="recent-panel">
        <div class="panel-header">
          <h3>${activeWs ? "Instances" : "Recent Instances"}</h3>
          <button class="btn btn-inline" data-nav="compute">View All →</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Image</th>
                <th>Type</th>
                <th>Network</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody id="recent-instance-body">
              <tr><td colspan="6" class="dim"><span class="spinner"></span> Memuat...</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    `;

    root.querySelectorAll("[data-nav]").forEach((button) => {
      button.addEventListener("click", () => navigate(button.dataset.nav));
    });

    // Grafana panel (admin-only)
    root.querySelector("#dash-grafana-open")?.addEventListener("click", () => {
      window.open("/monitor/d/node-metrics?refresh=30s", "_blank", "noopener");
    });

    const cpuEl = root.querySelector("#m-cpu");
    const memEl = root.querySelector("#m-mem");
    const memSubEl = root.querySelector("#m-mem-sub");
    const diskEl = root.querySelector("#m-disk");
    const diskSubEl = root.querySelector("#m-disk-sub");
    const wsContent = root.querySelector("#workspaces-content");
    const healthEl = root.querySelector("#health-box");
    const bodyEl = root.querySelector("#recent-instance-body");
    const pCpu = root.querySelector("#p-cpu");
    const pMem = root.querySelector("#p-mem");
    const pDisk = root.querySelector("#p-disk");
    const recentPanel = root.querySelector("#recent-panel");
    const instanceMetricsPanel = root.querySelector("#instance-metrics-panel");
    const instanceMetricsContent = root.querySelector("#instance-metrics-content");

    // Stat card elements
    const sInstances = root.querySelector("#s-instances");
    const sInstancesDetail = root.querySelector("#s-instances-detail");
    const sDatabases = root.querySelector("#s-databases");
    const sDatabasesDetail = root.querySelector("#s-databases-detail");
    const sBuckets = root.querySelector("#s-buckets");
    const sNetworks = root.querySelector("#s-networks");
    const sNetworksDetail = root.querySelector("#s-networks-detail");

    function resolveNetworkName(networkId, networks) {
      if (!networkId) return "-";
      const net = networks.find((n) => n.id === networkId);
      return net ? net.name : networkId.slice(0, 8) + "…";
    }

    async function renderInstanceMetrics(running) {
      if (running.length === 0) {
        instanceMetricsContent.innerHTML = `
          <div class="empty-state" style="padding:14px 0;">
            <p class="muted">Tidak ada instance running${activeWs ? " di workspace ini" : ""}.</p>
          </div>`;
        return;
      }

      // Fetch live metrics for all running instances in parallel
      const withMetrics = await Promise.all(
        running.map(async (inst) => {
          try {
            // Try Prometheus/cAdvisor first (richer data)
            const m = await apis.monitor.instanceMetrics(inst.id);
            if (m.metrics?.cpu_percent != null) {
              return { ...inst, cpu: m.metrics.cpu_percent, mem: m.metrics.memory_mb, memLimit: inst.memory_mb, netRx: m.metrics.network_rx_bytes_sec };
            }
          } catch {
            // Fallback to Docker stats
          }
          try {
            const s = await apis.compute.getInstanceStatus(inst.id);
            return { ...inst, cpu: s.cpu_percent, mem: s.mem_usage_mb, memLimit: s.mem_limit_mb || inst.memory_mb };
          } catch {
            return { ...inst, cpu: null, mem: null, memLimit: inst.memory_mb };
          }
        })
      );

      instanceMetricsContent.innerHTML = withMetrics
        .map((inst) => {
          const cpu = inst.cpu != null ? Number(inst.cpu) : null;
          const mem = inst.mem != null ? Number(inst.mem) : null;
          const memLimit = inst.memLimit || 256;
          const memPct = mem != null ? (mem / memLimit) * 100 : 0;
          const cpuClamped = clampPercent(cpu || 0);
          const memClamped = clampPercent(memPct || 0);

          return `
            <div style="display:flex;align-items:center;gap:14px;padding:8px 0;border-bottom:1px solid var(--border-subtle);">
              <div style="min-width:120px;">
                <strong style="font-size:13px;">${escapeHtml(inst.name)}</strong>
                <div class="muted" style="font-size:10px;">${escapeHtml(inst.instance_type)}</div>
              </div>
              <div style="flex:1;min-width:100px;">
                <div style="display:flex;justify-content:space-between;font-size:11px;">
                  <span>CPU</span>
                  <span class="mono">${cpu != null ? cpu.toFixed(1) + "%" : "N/A"}</span>
                </div>
                <div class="progress${cpuClamped > 80 ? " danger" : cpuClamped > 60 ? " warn" : ""}" style="height:5px;">
                  <span style="width:${cpuClamped}%;height:5px;"></span>
                </div>
              </div>
              <div style="flex:1;min-width:100px;">
                <div style="display:flex;justify-content:space-between;font-size:11px;">
                  <span>Memory</span>
                  <span class="mono">${mem != null ? mem.toFixed(0) + " / " + memLimit + " MB" : "N/A"}</span>
                </div>
                <div class="progress${memClamped > 80 ? " danger" : memClamped > 60 ? " warn" : ""}" style="height:5px;">
                  <span style="width:${memClamped}%;height:5px;"></span>
                </div>
              </div>
              <button class="btn btn-inline btn-sm" data-nav="monitoring" style="white-space:nowrap;">Charts & Logs →</button>
            </div>`;
        })
        .join("");
    }

    async function load() {
      const [summary, health, instancesPayload, dbPayload, bucketPayload, host] = await Promise.all([
        apis.monitor.summary(),
        apis.monitor.health(),
        apis.compute.listInstances(),
        apis.database.list().catch(() => ({ databases: [] })),
        apis.storage.listBuckets().catch(() => ({ buckets: [] })),
        state.user?.is_admin ? apis.monitor.host() : Promise.resolve(null),
      ]);

      // Host metrics
      if (host) {
        const cpu = Number(host.cpu_percent || 0);
        const mem = Number(host.memory_percent || 0);
        const disk = Number(host.disk_percent || 0);
        cpuEl.textContent = `${cpu.toFixed(1)}%`;
        memEl.textContent = `${mem.toFixed(1)}%`;
        diskEl.textContent = `${disk.toFixed(1)}%`;
        memSubEl.textContent = `${host.memory_used_gb} / ${host.memory_total_gb} GB`;
        diskSubEl.textContent = `${host.disk_used_gb} / ${host.disk_total_gb} GB`;
        pCpu.style.width = `${clampPercent(cpu)}%`;
        pMem.style.width = `${clampPercent(mem)}%`;
        pDisk.style.width = `${clampPercent(disk)}%`;
        // Color thresholds
        pCpu.parentElement.className = `progress${cpu > 80 ? " danger" : cpu > 60 ? " warn" : ""}`;
        pMem.parentElement.className = `progress${mem > 80 ? " danger" : mem > 60 ? " warn" : ""}`;
        pDisk.parentElement.className = `progress${disk > 80 ? " danger" : disk > 60 ? " warn" : ""}`;
      } else {
        cpuEl.textContent = "—";
        memEl.textContent = "—";
        diskEl.textContent = "—";
        memSubEl.textContent = "Admin-only";
        diskSubEl.textContent = "Admin-only";
        pCpu.style.width = "0%";
        pMem.style.width = "0%";
        pDisk.style.width = "0%";
      }

      // Health strip
      healthEl.className = "";
      healthEl.innerHTML = `
        <div class="health-strip">
          <div class="health-item">
            <span class="health-dot ${health?.status === "ok" ? "ok" : "err"}"></span>
            <span>${escapeHtml(health?.service || "IaaS API")}</span>
          </div>
          <div class="health-item">
            <span class="health-dot ok"></span>
            <span>Gateway</span>
          </div>
          <div class="health-item">
            <span class="health-dot ok"></span>
            <span>Storage</span>
          </div>
        </div>
        <div class="muted" style="font-size:12px;margin-top:10px;">
          Last check: ${escapeHtml(toLocalDate(health?.time))}
        </div>
      `;

      const instances = instancesPayload.instances || [];
      const databases = dbPayload.databases || [];
      const buckets = bucketPayload.buckets || [];
      const networks = state.networks || [];

      // Stat cards
      const running = instances.filter((i) => i.status === "running").length;
      const stopped = instances.filter((i) => i.status === "stopped").length;
      const available = databases.filter((d) => d.status === "available").length;

      sInstances.textContent = instances.length;
      sInstancesDetail.textContent = `${running} running, ${stopped} stopped`;
      sDatabases.textContent = databases.length;
      sDatabasesDetail.textContent = `${available} available`;
      sBuckets.textContent = buckets.length;
      sNetworks.textContent = networks.filter((n) => !n.is_default).length;
      sNetworksDetail.textContent = `${networks.length} total (incl. default)`;

      // ── Running Instance Metrics ──
      const runningInstances = instances.filter((i) => i.status === "running");
      if (activeWs) {
        // When a workspace is selected, only show instances in that workspace
        const wsRunning = runningInstances.filter((i) => i.network_id === activeWs);
        renderInstanceMetrics(wsRunning);
      } else {
        renderInstanceMetrics(runningInstances);
      }

      // ── Workspace panel ──
      if (activeWs) {
        const wsNet = networks.find((n) => n.id === activeWs);
        const wsName = wsNet ? wsNet.name : activeWs.slice(0, 8);
        const wsCidr = wsNet ? wsNet.cidr : "-";

        const wsInstances = instances.filter((i) => i.network_id === activeWs);
        const wsDatabases = databases.filter((d) => d.network_id === activeWs);

        const wsRunning = wsInstances.filter((i) => i.status === "running").length;
        const wsStopped = wsInstances.filter((i) => i.status === "stopped").length;

        wsContent.innerHTML = `
          <div style="margin-bottom:14px;">
            <div class="muted" style="font-size:12px;">Network</div>
            <div><strong>${escapeHtml(wsName)}</strong> <span class="mono muted">${escapeHtml(wsCidr)}</span></div>
          </div>
          <div class="quick-actions">
            <button class="btn btn-inline" data-nav="compute">+ Instance</button>
            <button class="btn btn-inline" data-nav="database">+ Database</button>
            <button class="btn btn-inline" data-nav="storage">+ Bucket</button>
          </div>
          <div class="grid grid-3">
            <div class="metric">
              <div class="label">Instances</div>
              <div class="value">${wsInstances.length}</div>
              <div class="hint">${wsRunning} running, ${wsStopped} stopped</div>
            </div>
            <div class="metric">
              <div class="label">Databases</div>
              <div class="value">${wsDatabases.length}</div>
              <div class="hint">${wsDatabases.filter((d) => d.status === "available").length} available</div>
            </div>
            <div class="metric">
              <div class="label">Buckets</div>
              <div class="value">${buckets.length}</div>
              <div class="hint">Object storage</div>
            </div>
          </div>
        `;
        recentPanel.querySelector("h3").textContent = `Instances in ${wsName}`;
      } else {
        const userNetworks = networks.filter((n) => !n.is_default);
        if (userNetworks.length === 0) {
          wsContent.innerHTML = `
            <div class="empty-state" style="padding:20px 0;">
              <div class="empty-icon"><img src="/assets/icons/network.png" alt="" width="40" height="40" style="opacity:0.5;" /></div>
              <p>Belum ada workspace. Buat network dulu untuk memulai project.</p>
              <button class="btn btn-primary btn-inline" data-nav="network">Buat Network</button>
            </div>
          `;
        } else {
          wsContent.innerHTML = `<div class="grid grid-2" style="gap:10px;">${userNetworks
            .map((net) => {
              const netInstances = instances.filter((i) => i.network_id === net.id);
              const netDbs = databases.filter((d) => d.network_id === net.id);
              const netRunning = netInstances.filter((i) => i.status === "running").length;
              return `
                <div class="workspace-card" data-ws-select="${net.id}">
                  <h3>${escapeHtml(net.name)}</h3>
                  <div class="meta"><span class="mono">${escapeHtml(net.cidr || "auto")}</span>${net.gateway ? " / gw " + escapeHtml(net.gateway) : ""}</div>
                  <div class="stats">
                    <span><img src="/assets/icons/server-dan-instance.png" alt="" width="14" height="14" style="vertical-align:middle;" /> ${netInstances.length} instance${netRunning ? ` (${netRunning} running)` : ""}</span>
                    <span><img src="/assets/icons/database.png" alt="" width="14" height="14" style="vertical-align:middle;" /> ${netDbs.length} database</span>
                  </div>
                </div>
              `;
            })
            .join("")}</div>`;

          wsContent.querySelectorAll("[data-ws-select]").forEach((card) => {
            card.addEventListener("click", () => {
              state.activeWorkspace = card.dataset.wsSelect;
              const sel = document.getElementById("workspace-select");
              if (sel) sel.value = card.dataset.wsSelect;
              navigate("dashboard");
            });
          });
        }
        recentPanel.querySelector("h3").textContent = "Recent Instances";
      }

      // Re-bind data-nav buttons in workspace + metrics content
      wsContent.querySelectorAll("[data-nav]").forEach((btn) => {
        btn.addEventListener("click", () => navigate(btn.dataset.nav));
      });
      instanceMetricsContent.querySelectorAll("[data-nav]").forEach((btn) => {
        btn.addEventListener("click", () => navigate(btn.dataset.nav));
      });

      // ── Instance table ──
      let list = instances;
      if (activeWs) {
        list = instances.filter((i) => i.network_id === activeWs);
      } else {
        list = instances.slice(0, 8);
      }
      if (list.length === 0) {
        bodyEl.innerHTML = `<tr><td colspan="6" class="dim">Belum ada instance${activeWs ? " di workspace ini" : ""}.</td></tr>`;
      } else {
        bodyEl.innerHTML = list
          .map(
            (item) => `
              <tr>
                <td><strong>${escapeHtml(item.name)}</strong></td>
                <td><span class="status ${statusClass(item.status)}">${item.status}</span>${item.status_detail && item.status !== "running" && item.status !== "terminated" ? `<div class="muted" style="font-size:0.7rem;">${escapeHtml(item.status_detail)}</div>` : ""}</td>
                <td>${escapeHtml(item.image)}</td>
                <td><span class="chip mono">${escapeHtml(item.instance_type)}</span></td>
                <td><span class="resource-link" data-nav-to="network" data-hl-net="${item.network_id || ""}">${escapeHtml(resolveNetworkName(item.network_id, networks))}</span></td>
                <td class="muted">${toLocalDate(item.created_at)}</td>
              </tr>
            `,
          )
          .join("");
      }

      // Cross-navigation
      bodyEl.querySelectorAll("[data-nav-to]").forEach((link) => {
        link.addEventListener("click", () => {
          const targetView = link.dataset.navTo;
          if (link.dataset.hlNet) {
            state.activeWorkspace = link.dataset.hlNet;
            const sel = document.getElementById("workspace-select");
            if (sel) sel.value = link.dataset.hlNet;
          }
          navigate(targetView);
        });
      });
    }

    await load();
    const timer = window.setInterval(() => {
      load().catch(() => {});
    }, REFRESH_MS);

    return () => window.clearInterval(timer);
  },
};
