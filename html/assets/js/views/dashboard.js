import { REFRESH_MS } from "../config.js";
import { clampPercent, escapeHtml, statusClass, toLocalDate } from "../utils.js";

export const dashboardView = {
  id: "dashboard",
  title: "Dashboard",
  subtitle: "Ringkasan instance dan status layanan.",
  async mount(root, { apis, navigate, state }) {
    root.innerHTML = `
      <div class="grid grid-3">
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

      <div class="grid grid-2">
        <section class="panel">
          <h3>Compute Summary</h3>
          <div id="summary-data" class="dim"><span class="spinner"></span> Memuat�</div>
          <div class="toolbar" style="margin-top:10px;">
            <button class="btn btn-inline" data-nav="compute">Buka Compute</button>
            <button class="btn btn-inline" data-nav="network">Buka Network</button>
            <button class="btn btn-inline" data-nav="storage">Buka Storage</button>
          </div>
        </section>

        <section class="panel">
          <h3>Service Health</h3>
          <div id="health-box" class="dim"><span class="spinner"></span> Memuat...</div>
        </section>
      </div>

      <section class="panel">
        <h3>Recent Instances</h3>
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
              <tr><td colspan="6" class="dim"><span class="spinner"></span> Memuat�</td></tr>
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
    const summaryEl = root.querySelector("#summary-data");
    const healthEl = root.querySelector("#health-box");
    const bodyEl = root.querySelector("#recent-instance-body");
    const pCpu = root.querySelector("#p-cpu");
    const pMem = root.querySelector("#p-mem");
    const pDisk = root.querySelector("#p-disk");

    async function load() {
      const [summary, health, instancesPayload, host] = await Promise.all([
        apis.monitor.summary(),
        apis.monitor.health(),
        apis.compute.listInstances(),
        state.user?.is_admin ? apis.monitor.host() : Promise.resolve(null),
      ]);

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

      summaryEl.innerHTML = `
        <div class="grid">
          <div>Scope: <strong>${summary.scope || "self"}</strong></div>
          <div>Running: <strong>${summary.instances.running}</strong></div>
          <div>Stopped: <strong>${summary.instances.stopped}</strong></div>
          <div>Total Instances: <strong>${summary.instances.total}</strong></div>
          ${
            summary.users != null
              ? `<div>Total Users: <strong>${summary.users}</strong></div>`
              : `<div class="dim">User count only visible to admin.</div>`
          }
        </div>
      `;

      healthEl.className = "grid";
      healthEl.innerHTML = `
        <div>Status: <strong>${escapeHtml(health?.status || "-")}</strong></div>
        <div>Service: <strong>${escapeHtml(health?.service || "-")}</strong></div>
        <div>Waktu: <strong>${escapeHtml(toLocalDate(health?.time))}</strong></div>
      `;

      const list = (instancesPayload.instances || []).slice(0, 8);
      if (list.length === 0) {
        bodyEl.innerHTML = `<tr><td colspan="6" class="dim">Belum ada instance.</td></tr>`;
      } else {
        bodyEl.innerHTML = list
          .map(
            (item) => `
              <tr>
                <td>${escapeHtml(item.name)}</td>
                <td><span class="status ${statusClass(item.status)}">${item.status}</span></td>
                <td>${escapeHtml(item.image)}</td>
                <td><span class="chip mono">${escapeHtml(item.instance_type)}</span></td>
                <td class="mono">${escapeHtml(item.network_id || "-")}</td>
                <td>${toLocalDate(item.created_at)}</td>
              </tr>
            `,
          )
          .join("");
      }
    }

    await load();
    const timer = window.setInterval(() => {
      load().catch(() => {
        // keep view alive on intermittent failures
      });
    }, REFRESH_MS);

    return () => window.clearInterval(timer);
  },
};
