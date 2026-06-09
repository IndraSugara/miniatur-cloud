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

      <section class="panel" id="workspaces-panel">
        <div class="toolbar" style="justify-content:space-between;margin-bottom:12px;">
          <h3 style="margin:0;">${activeWs ? "Workspace Resources" : "Workspaces"}</h3>
          ${!activeWs ? `<button class="btn btn-inline" data-nav="network">Manage Networks</button>` : ""}
        </div>
        <div id="workspaces-content"><span class="dim"><span class="spinner"></span> Memuat...</span></div>
      </section>

      <section class="panel" id="service-panel">
        <h3>Service Health</h3>
        <div id="health-box" class="dim"><span class="spinner"></span> Memuat...</div>
      </section>

      <section class="panel" id="recent-panel">
        <h3>${activeWs ? "Instances" : "Recent Instances"}</h3>
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

    function resolveNetworkName(networkId, networks) {
      if (!networkId) return "-";
      const net = networks.find((n) => n.id === networkId);
      return net ? net.name : networkId.slice(0, 8) + "…";
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
      } else {
        cpuEl.textContent = "Restricted";
        memEl.textContent = "Restricted";
        diskEl.textContent = "Restricted";
        memSubEl.textContent = "Host metrics admin-only";
        diskSubEl.textContent = "Host metrics admin-only";
        pCpu.style.width = "0%";
        pMem.style.width = "0%";
        pDisk.style.width = "0%";
      }

      // Health
      healthEl.className = "grid";
      healthEl.innerHTML = `
        <div>Status: <strong>${escapeHtml(health?.status || "-")}</strong></div>
        <div>Service: <strong>${escapeHtml(health?.service || "-")}</strong></div>
        <div>Waktu: <strong>${escapeHtml(toLocalDate(health?.time))}</strong></div>
      `;

      const instances = instancesPayload.instances || [];
      const databases = dbPayload.databases || [];
      const buckets = bucketPayload.buckets || [];
      const networks = state.networks || [];

      // ── Workspace panel ──
      if (activeWs) {
        // Showing resources in the selected workspace
        const wsNet = networks.find((n) => n.id === activeWs);
        const wsName = wsNet ? wsNet.name : activeWs.slice(0, 8);
        const wsCidr = wsNet ? wsNet.cidr : "-";

        const wsInstances = instances.filter((i) => i.network_id === activeWs);
        const wsDatabases = databases.filter((d) => d.network_id === activeWs);

        const running = wsInstances.filter((i) => i.status === "running").length;
        const stopped = wsInstances.filter((i) => i.status === "stopped").length;

        wsContent.innerHTML = `
          <div class="grid grid-2" style="margin-bottom:14px;">
            <div>
              <div class="dim" style="font-size:12px;">Network</div>
              <div><strong>${escapeHtml(wsName)}</strong> <span class="mono dim">${escapeHtml(wsCidr)}</span></div>
            </div>
            <div>
              <div class="dim" style="font-size:12px;">Quick Actions</div>
              <div class="toolbar" style="margin-top:4px;">
                <button class="btn btn-inline" data-nav="compute">+ Instance</button>
                <button class="btn btn-inline" data-nav="database">+ Database</button>
                <button class="btn btn-inline" data-nav="storage">+ Bucket</button>
              </div>
            </div>
          </div>
          <div class="grid grid-3">
            <div class="metric">
              <div class="label">Instances</div>
              <div class="value">${wsInstances.length}</div>
              <div class="hint">${running} running, ${stopped} stopped</div>
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
        // Show workspace cards (one per non-default network)
        const userNetworks = networks.filter((n) => !n.is_default);
        if (userNetworks.length === 0) {
          wsContent.innerHTML = `
            <p class="dim">Belum ada workspace. Buat network dulu untuk memulai project.</p>
            <button class="btn btn-inline" data-nav="network" style="margin-top:8px;">Buat Network</button>
          `;
        } else {
          wsContent.innerHTML = `<div class="grid grid-2">${userNetworks
            .map((net) => {
              const netInstances = instances.filter((i) => i.network_id === net.id);
              const netDbs = databases.filter((d) => d.network_id === net.id);
              const running = netInstances.filter((i) => i.status === "running").length;
              return `
                <div class="workspace-card" data-ws-select="${net.id}">
                  <h3>${escapeHtml(net.name)}</h3>
                  <div class="meta"><span class="mono">${escapeHtml(net.cidr || "auto")}</span>${net.gateway ? " / gw " + escapeHtml(net.gateway) : ""}</div>
                  <div class="stats">
                    <span>🖥 ${netInstances.length} instance${running ? ` (${running} running)` : ""}</span>
                    <span>🗄 ${netDbs.length} database</span>
                  </div>
                </div>
              `;
            })
            .join("")}</div>`;

          // Clicking a workspace card selects it
          wsContent.querySelectorAll("[data-ws-select]").forEach((card) => {
            card.addEventListener("click", () => {
              state.activeWorkspace = card.dataset.wsSelect;
              const sel = document.getElementById("workspace-select");
              if (sel) sel.value = card.dataset.wsSelect;
              // Re-mount dashboard with workspace selected
              navigate("dashboard");
            });
          });
        }
        recentPanel.querySelector("h3").textContent = "Recent Instances";
      }

      // Re-bind data-nav buttons in workspace content
      wsContent.querySelectorAll("[data-nav]").forEach((btn) => {
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
                <td>${escapeHtml(item.name)}</td>
                <td><span class="status ${statusClass(item.status)}">${item.status}</span>${item.status_detail && item.status !== "running" && item.status !== "terminated" ? `<div class="dim" style="font-size:0.7rem;">${escapeHtml(item.status_detail)}</div>` : ""}</td>
                <td>${escapeHtml(item.image)}</td>
                <td><span class="chip mono">${escapeHtml(item.instance_type)}</span></td>
                <td><span class="resource-link" data-nav-to="network" data-hl-net="${item.network_id || ""}">${escapeHtml(resolveNetworkName(item.network_id, networks))}</span></td>
                <td>${toLocalDate(item.created_at)}</td>
              </tr>
            `,
          )
          .join("");
      }

      // Cross-navigation: clicking network name goes to network view
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
