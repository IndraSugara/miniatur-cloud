import { REFRESH_MS } from "../config.js";
import { clampPercent } from "../utils.js";

export const monitoringView = {
  id: "monitoring",
  title: "Monitoring",
  subtitle: "Pantau resource host dan akses observability stack (admin).",
  async mount(root, { apis, state }) {
    if (!state.user?.is_admin) {
      root.innerHTML = `
        <section class="panel">
          <h3>Monitoring Infra</h3>
          <p class="message error">Akses monitoring host hanya untuk admin.</p>
          <p class="dim">User biasa hanya bisa memantau status instance miliknya di halaman Compute.</p>
        </section>
      `;
      return () => {};
    }

    root.innerHTML = `
      <section class="panel">
        <h3>Host Metrics Live</h3>
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

      <section class="panel">
        <div class="toolbar" style="justify-content:space-between;">
          <h3>Grafana Dashboard</h3>
          <button id="open-grafana-tab" class="btn btn-inline btn-ghost">Open in New Tab</button>
        </div>
        <div style="border-radius:var(--radius);overflow:hidden;border:1px solid var(--line);">
          <iframe id="grafana-frame" src="/monitor/"
            style="width:100%;height:500px;border:none;background:var(--panel);"
            loading="lazy"></iframe>
        </div>
        <p class="dim" style="margin-top:8px;font-size:0.8rem;">
          Jika Grafana tidak muncul, pastikan container cloud-dashboard sudah running.
          Login default: admin / admin
        </p>
      </section>

      <section class="panel">
        <h3>Raw Host Payload</h3>
        <pre id="raw-monitor" class="mono dim"><span class="spinner"></span> Memuat...</pre>
      </section>
    `;

    root.querySelector("#open-grafana-tab").addEventListener("click", () => {
      window.open("/monitor/", "_blank", "noopener");
    });

    const cpu = root.querySelector("#mon-cpu");
    const mem = root.querySelector("#mon-mem");
    const memSub = root.querySelector("#mon-mem-sub");
    const disk = root.querySelector("#mon-disk");
    const diskSub = root.querySelector("#mon-disk-sub");
    const raw = root.querySelector("#raw-monitor");

    const cpuBar = root.querySelector("#mon-cpu-bar");
    const memBar = root.querySelector("#mon-mem-bar");
    const diskBar = root.querySelector("#mon-disk-bar");

    async function load() {
      const payload = await apis.monitor.host();
      cpu.textContent = `${Number(payload.cpu_percent || 0).toFixed(1)}%`;
      mem.textContent = `${Number(payload.memory_percent || 0).toFixed(1)}%`;
      disk.textContent = `${Number(payload.disk_percent || 0).toFixed(1)}%`;
      memSub.textContent = `${payload.memory_used_gb} / ${payload.memory_total_gb} GB`;
      diskSub.textContent = `${payload.disk_used_gb} / ${payload.disk_total_gb} GB`;

      cpuBar.style.width = `${clampPercent(payload.cpu_percent)}%`;
      memBar.style.width = `${clampPercent(payload.memory_percent)}%`;
      diskBar.style.width = `${clampPercent(payload.disk_percent)}%`;

      raw.textContent = JSON.stringify(payload, null, 2);
    }

    await load();
    const timer = window.setInterval(() => {
      load().catch(() => {});
    }, REFRESH_MS);

    return () => window.clearInterval(timer);
  },
};