import { REFRESH_MS } from "../config.js";
import { clampPercent, escapeHtml } from "../utils.js";
import { showModal } from "../ui.js";

export const monitoringView = {
  id: "monitoring",
  title: "Monitoring",
  subtitle: "Pantau resource dan logs dari instance kamu.",
  async mount(root, { apis, state }) {
    const isAdmin = state.user?.is_admin || false;

    root.innerHTML = `
      <!-- Instance Monitoring Section (all users) -->
      <section class="panel">
        <div class="panel-header">
          <h3>Instance Monitoring</h3>
          <button id="mon-refresh" class="btn btn-inline btn-ghost">&circlearrowright; Refresh</button>
        </div>
        <div id="mon-instance-list">
          <span class="dim"><span class="spinner"></span> Loading instances...</span>
        </div>
      </section>

      ${isAdmin ? `
      <!-- Admin: Host Metrics -->
      <section class="panel">
        <div class="panel-header">
          <h3>Host Metrics</h3>
        </div>
        <div class="grid grid-3">
          <div class="metric">
            <div class="label">CPU</div>
            <div id="mon-cpu" class="value">-</div>
            <div class="progress"><span id="mon-cpu-bar" style="width:0%"></span></div>
          </div>
          <div class="metric">
            <div class="label">Memory</div>
            <div id="mon-mem" class="value">-</div>
            <div id="mon-mem-sub" class="hint">-</div>
            <div class="progress"><span id="mon-mem-bar" style="width:0%"></span></div>
          </div>
          <div class="metric">
            <div class="label">Disk</div>
            <div id="mon-disk" class="value">-</div>
            <div id="mon-disk-sub" class="hint">-</div>
            <div class="progress"><span id="mon-disk-bar" style="width:0%"></span></div>
          </div>
        </div>
      </section>

      <!-- Admin: Grafana -->
      <section class="panel">
        <div class="panel-header">
          <h3>Grafana Dashboard</h3>
          <button id="open-grafana-tab" class="btn btn-inline btn-ghost">Open in New Tab &nearr;</button>
        </div>
        <div style="border-radius:var(--radius-sm);overflow:hidden;border:1px solid var(--border);">
          <iframe id="grafana-frame" src="/monitor/"
            style="width:100%;height:400px;border:none;background:var(--bg-surface);"
            loading="lazy"></iframe>
        </div>
        <p class="muted" style="margin-top:8px;font-size:12px;">
          Jika Grafana tidak muncul, pastikan container cloud-dashboard berjalan. Login default: admin / admin
        </p>
      </section>
      ` : ""}
    `;

    const instanceList = root.querySelector("#mon-instance-list");

    // ── Load instance metrics (all users) ──
    async function loadInstanceMetrics() {
      try {
        const payload = await apis.compute.listInstances();
        const instances = (payload.instances || []).filter(
          (i) => i.status === "running"
        );

        if (instances.length === 0) {
          instanceList.innerHTML = `
            <div class="empty-state" style="padding:20px 0;">
              <p>Tidak ada instance running untuk dimonitor.</p>
              <p class="muted" style="font-size:13px;">Buat instance di halaman Compute, lalu kembali ke sini untuk melihat metrics.</p>
            </div>`;
          return;
        }

        // Fetch live metrics for all running instances
        const withMetrics = await Promise.all(
          instances.map(async (inst) => {
            try {
              const m = await apis.monitor.instanceMetrics(inst.id);
              return { ...inst, liveMetrics: m.metrics };
            } catch {
              return { ...inst, liveMetrics: null };
            }
          })
        );

        instanceList.innerHTML = withMetrics
          .map((inst) => {
            const cpu = inst.liveMetrics?.cpu_percent;
            const mem = inst.liveMetrics?.memory_mb;
            const memLimit = inst.memory_mb;
            const netRx = inst.liveMetrics?.network_rx_bytes_sec;
            const netTx = inst.liveMetrics?.network_tx_bytes_sec;
            const memPct = mem && memLimit ? (mem / memLimit) * 100 : 0;
            const cpuClamped = clampPercent(cpu || 0);

            return `
            <div class="mon-instance-card" style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:14px;margin-bottom:10px;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                <strong>${escapeHtml(inst.name)}</strong>
                <span class="chip mono" style="font-size:11px;">${escapeHtml(inst.instance_type)}</span>
              </div>
              <div class="grid grid-3" style="gap:10px;">
                <div class="metric">
                  <div class="label" style="font-size:11px;">CPU</div>
                  <div class="value" style="font-size:18px;">${cpu != null ? cpu.toFixed(1) + "%" : "N/A"}</div>
                  <div class="progress${cpuClamped > 80 ? " danger" : cpuClamped > 60 ? " warn" : ""}">
                    <span style="width:${cpuClamped}%;"></span>
                  </div>
                </div>
                <div class="metric">
                  <div class="label" style="font-size:11px;">Memory</div>
                  <div class="value" style="font-size:18px;">${mem != null ? mem.toFixed(0) + " MB" : "N/A"}</div>
                  <div class="progress${memPct > 80 ? " danger" : memPct > 60 ? " warn" : ""}">
                    <span style="width:${clampPercent(memPct)}%;"></span>
                  </div>
                </div>
                <div class="metric">
                  <div class="label" style="font-size:11px;">Network</div>
                  <div class="value" style="font-size:18px;">${netRx != null ? (netRx / 1024).toFixed(1) + " KB/s" : "N/A"}</div>
                  <div class="hint" style="font-size:10px;">RX / TX: ${netTx != null ? (netTx / 1024).toFixed(1) : "?"} KB/s</div>
                </div>
              </div>
              <div style="margin-top:10px;display:flex;gap:6px;">
                <button class="btn btn-inline btn-sm" data-action="chart" data-id="${inst.id}" data-name="${escapeHtml(inst.name)}">&boxur; Charts</button>
                <button class="btn btn-inline btn-sm" data-action="logs" data-id="${inst.id}" data-name="${escapeHtml(inst.name)}">&boxbox; Logs</button>
              </div>
            </div>`;
          })
          .join("");
      } catch (error) {
        instanceList.innerHTML = `<p class="message error">${error.message}</p>`;
      }
    }

    // ── Admin-only: host metrics ──
    let hostTimer = null;
    if (isAdmin) {
      const cpuEl = root.querySelector("#mon-cpu");
      const memEl = root.querySelector("#mon-mem");
      const memSubEl = root.querySelector("#mon-mem-sub");
      const diskEl = root.querySelector("#mon-disk");
      const diskSubEl = root.querySelector("#mon-disk-sub");
      const cpuBar = root.querySelector("#mon-cpu-bar");
      const memBar = root.querySelector("#mon-mem-bar");
      const diskBar = root.querySelector("#mon-disk-bar");

      async function loadHost() {
        try {
          const payload = await apis.monitor.host();
          const cpuVal = Number(payload.cpu_percent || 0);
          const memVal = Number(payload.memory_percent || 0);
          const diskVal = Number(payload.disk_percent || 0);
          cpuEl.textContent = `${cpuVal.toFixed(1)}%`;
          memEl.textContent = `${memVal.toFixed(1)}%`;
          diskEl.textContent = `${diskVal.toFixed(1)}%`;
          memSubEl.textContent = `${payload.memory_used_gb} / ${payload.memory_total_gb} GB`;
          diskSubEl.textContent = `${payload.disk_used_gb} / ${payload.disk_total_gb} GB`;
          cpuBar.style.width = `${clampPercent(cpuVal)}%`;
          memBar.style.width = `${clampPercent(memVal)}%`;
          diskBar.style.width = `${clampPercent(diskVal)}%`;
          cpuBar.parentElement.className = `progress${cpuVal > 80 ? " danger" : cpuVal > 60 ? " warn" : ""}`;
          memBar.parentElement.className = `progress${memVal > 80 ? " danger" : memVal > 60 ? " warn" : ""}`;
          diskBar.parentElement.className = `progress${diskVal > 80 ? " danger" : diskVal > 60 ? " warn" : ""}`;
        } catch {
          // silently ignore host polling errors
        }
      }
      await loadHost();
      hostTimer = window.setInterval(loadHost, REFRESH_MS);

      root.querySelector("#open-grafana-tab")?.addEventListener("click", () => {
        window.open("/monitor/", "_blank", "noopener");
      });
    }

    // ── Event delegation for chart/log buttons ──
    instanceList.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      const iid = btn.dataset.id;
      const name = btn.dataset.name;
      if (action === "chart") {
        openChartModal(iid, name, apis);
      } else if (action === "logs") {
        openLogModal(iid, name, apis);
      }
    });

    root.querySelector("#mon-refresh")?.addEventListener("click", loadInstanceMetrics);

    await loadInstanceMetrics();
    const timer = window.setInterval(loadInstanceMetrics, REFRESH_MS * 2);

    return () => {
      window.clearInterval(timer);
      if (hostTimer) window.clearInterval(hostTimer);
    };
  },
};

// ── Chart Modal ─────────────────────────────────────────────────

function openChartModal(instanceId, instanceName, apis) {
  const modal = showModal({
    title: `Charts — ${escapeHtml(instanceName)}`,
    bodyHtml: `
      <div class="toolbar" style="margin-bottom:12px;display:flex;align-items:center;flex-wrap:wrap;gap:8px;">
        <label class="field-label" style="margin:0;">Time Range:</label>
        <select id="chart-range" style="width:auto;">
          <option value="30m">Last 30 min</option>
          <option value="1h" selected>Last 1 hour</option>
          <option value="3h">Last 3 hours</option>
          <option value="6h">Last 6 hours</option>
          <option value="24h">Last 24 hours</option>
        </select>
        <button id="chart-refresh" class="btn btn-inline btn-ghost" style="margin-left:4px;">&circlearrowright; Refresh</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
        <div style="position:relative;height:180px;"><canvas id="chart-cpu"></canvas></div>
        <div style="position:relative;height:180px;"><canvas id="chart-mem"></canvas></div>
        <div style="position:relative;height:180px;"><canvas id="chart-net"></canvas></div>
        <div style="display:flex;flex-direction:column;justify-content:center;padding:12px;border:1px solid var(--border);border-radius:var(--radius-sm);">
          <div class="muted" style="font-size:11px;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">Live Metrics</div>
          <div id="chart-live-cpu" style="font-size:14px;margin-bottom:4px;">CPU: --</div>
          <div id="chart-live-mem" style="font-size:14px;margin-bottom:4px;">Mem: --</div>
          <div id="chart-live-net" style="font-size:14px;">Net: --</div>
        </div>
      </div>
      <p id="chart-status" class="dim" style="margin-top:10px;font-size:12px;"></p>
    `,
  });

  let cpuChart, memChart, netChart;
  const rangeSelect = modal.wrapper.querySelector("#chart-range");
  const refreshBtn = modal.wrapper.querySelector("#chart-refresh");
  const canvasCpu = modal.wrapper.querySelector("#chart-cpu");
  const canvasMem = modal.wrapper.querySelector("#chart-mem");
  const canvasNet = modal.wrapper.querySelector("#chart-net");
  const liveCpu = modal.wrapper.querySelector("#chart-live-cpu");
  const liveMem = modal.wrapper.querySelector("#chart-live-mem");
  const liveNet = modal.wrapper.querySelector("#chart-live-net");
  const statusEl = modal.wrapper.querySelector("#chart-status");

  function timeRangeToParams(range) {
    return { start: `now-${range}`, end: "now", step: range.endsWith("h") ? "1m" : "15s" };
  }

  function formatTimestamps(data) {
    return (data || []).map((p) => {
      const d = new Date(p.t * 1000);
      return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    });
  }

  async function loadCharts() {
    try {
      const range = rangeSelect.value;
      const params = timeRangeToParams(range);
      const data = await apis.monitor.instanceMetricsRange(
        instanceId, params.start, params.end, params.step
      );

      const labels = formatTimestamps(data.cpu_percent);

      // Destroy existing charts
      if (cpuChart) { cpuChart.destroy(); cpuChart = null; }
      if (memChart) { memChart.destroy(); memChart = null; }
      if (netChart) { netChart.destroy(); netChart = null; }

      // CPU chart
      cpuChart = new Chart(canvasCpu.getContext("2d"), {
        type: "line",
        data: {
          labels,
          datasets: [{
            label: "CPU %",
            data: (data.cpu_percent || []).map((p) => p.v),
            borderColor: "#ff8c00",
            backgroundColor: "rgba(255,140,0,0.08)",
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 1.5,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { font: { size: 9 }, maxTicksLimit: 8 }, grid: { display: false } },
            y: { beginAtZero: true, max: 100, ticks: { font: { size: 9 }, callback: (v) => v + "%" }, grid: { color: "rgba(0,0,0,0.04)" } },
          },
        },
      });

      // Memory chart
      memChart = new Chart(canvasMem.getContext("2d"), {
        type: "line",
        data: {
          labels,
          datasets: [{
            label: "Memory MB",
            data: (data.memory_mb || []).map((p) => p.v),
            borderColor: "#1967d2",
            backgroundColor: "rgba(25,103,210,0.08)",
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 1.5,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { font: { size: 9 }, maxTicksLimit: 8 }, grid: { display: false } },
            y: { beginAtZero: true, ticks: { font: { size: 9 }, callback: (v) => v + " MB" }, grid: { color: "rgba(0,0,0,0.04)" } },
          },
        },
      });

      // Network chart (RX + TX)
      const rxData = data.network_rx_bytes_sec || [];
      const txData = data.network_tx_bytes_sec || [];
      netChart = new Chart(canvasNet.getContext("2d"), {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: "RX KB/s",
              data: rxData.map((p) => p.v / 1024),
              borderColor: "#34a853",
              backgroundColor: "rgba(52,168,83,0.06)",
              fill: true,
              tension: 0.3,
              pointRadius: 0,
              borderWidth: 1.5,
            },
            {
              label: "TX KB/s",
              data: txData.map((p) => p.v / 1024),
              borderColor: "#ea4335",
              backgroundColor: "rgba(234,67,53,0.06)",
              fill: true,
              tension: 0.3,
              pointRadius: 0,
              borderWidth: 1.5,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: true, labels: { boxWidth: 8, font: { size: 10 }, usePointStyle: true } } },
          scales: {
            x: { ticks: { font: { size: 9 }, maxTicksLimit: 8 }, grid: { display: false } },
            y: { beginAtZero: true, ticks: { font: { size: 9 }, callback: (v) => v.toFixed(1) + " KB/s" }, grid: { color: "rgba(0,0,0,0.04)" } },
          },
        },
      });

      statusEl.textContent = `Updated: ${new Date().toLocaleTimeString()} • ${data.cpu_percent?.length || 0} data points`;

      // Live metrics
      try {
        const live = await apis.monitor.instanceMetrics(instanceId);
        if (live.metrics) {
          liveCpu.textContent = `CPU: ${live.metrics.cpu_percent != null ? live.metrics.cpu_percent.toFixed(1) : "N/A"}%`;
          liveMem.textContent = `Mem: ${live.metrics.memory_mb != null ? live.metrics.memory_mb.toFixed(0) : "N/A"} MB`;
          liveNet.textContent = `Net: ${live.metrics.network_rx_bytes_sec != null ? (live.metrics.network_rx_bytes_sec / 1024).toFixed(1) : "N/A"} KB/s RX`;
        }
      } catch {
        // live metrics are non-critical
      }
    } catch (error) {
      statusEl.textContent = `Error: ${error.message}`;
    }
  }

  loadCharts();
  refreshBtn.addEventListener("click", loadCharts);
  rangeSelect.addEventListener("change", loadCharts);
}

// ── Logs Modal ──────────────────────────────────────────────────

function openLogModal(instanceId, instanceName, apis) {
  const modal = showModal({
    title: `Logs — ${escapeHtml(instanceName)}`,
    bodyHtml: `
      <div class="toolbar" style="margin-bottom:10px;display:flex;align-items:center;flex-wrap:wrap;gap:6px;">
        <input id="log-search" placeholder="Search in logs..." style="flex:1;min-width:140px;" />
        <button id="log-search-btn" class="btn btn-inline">Search</button>
        <label class="field-label" style="margin:0;font-size:10px;">Lines:</label>
        <select id="log-limit" style="width:70px;">
          <option value="50">50</option>
          <option value="100" selected>100</option>
          <option value="200">200</option>
          <option value="500">500</option>
        </select>
        <button id="log-refresh" class="btn btn-inline btn-ghost">&circlearrowright;</button>
      </div>
      <pre id="log-output" style="min-height:250px;max-height:420px;overflow:auto;font-size:0.75rem;white-space:pre-wrap;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px;font-family:var(--font-mono,monospace);"><span class="spinner"></span> Loading logs...</pre>
    `,
  });

  const output = modal.wrapper.querySelector("#log-output");
  const searchInput = modal.wrapper.querySelector("#log-search");
  const searchBtn = modal.wrapper.querySelector("#log-search-btn");
  const limitSelect = modal.wrapper.querySelector("#log-limit");
  const refreshBtn = modal.wrapper.querySelector("#log-refresh");

  async function loadLogs() {
    output.innerHTML = '<span class="spinner"></span> Loading logs...';
    try {
      const search = searchInput.value.trim() || undefined;
      const limit = parseInt(limitSelect.value, 10);
      const result = await apis.monitor.instanceLogs(instanceId, { search, limit });
      const entries = result.entries || [];
      if (entries.length === 0) {
        output.textContent = "(no log entries found)";
        return;
      }
      output.textContent = entries
        .map((e) => {
          const ts = new Date(parseInt(e.timestamp_ns, 10) / 1_000_000).toISOString();
          return `[${ts}] ${e.line}`;
        })
        .join("\n");
      output.scrollTop = output.scrollHeight;
    } catch (error) {
      output.textContent = `Error: ${error.message}`;
    }
  }

  loadLogs();
  refreshBtn.addEventListener("click", loadLogs);
  searchBtn.addEventListener("click", loadLogs);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadLogs();
  });
}
