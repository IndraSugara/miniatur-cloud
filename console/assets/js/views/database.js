/**
 * Database (RDS) view — managed PostgreSQL databases.
 */

import { REFRESH_MS } from "../config.js";
import { escapeHtml, toLocalDate } from "../utils.js";
import { showModal, toast } from "../ui.js";

function errMsg(error) {
  return error instanceof Error ? error.message : String(error);
}

function statusBadge(status) {
  const map = {
    available: '<span class="status available">available</span>',
    creating: '<span class="status creating">creating</span>',
    stopped: '<span class="status stopped">stopped</span>',
    deleting: '<span class="status deleting">deleting</span>',
    error: '<span class="status error">error</span>',
  };
  return map[status] || `<span class="status stopped">${escapeHtml(status)}</span>`;
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} disalin!`);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    toast(`${label} disalin!`);
  }
}

export const databaseView = {
  id: "database",
  title: "Database (RDS)",
  subtitle: "Kelola managed PostgreSQL databases.",

  async mount(root, { apis, navigate, state }) {
    const activeWs = state.activeWorkspace;
    let databases = [];
    let networks = [];

    function resolveNetworkName(networkId) {
      if (!networkId) return "-";
      const net = networks.find((n) => n.id === networkId);
      return net ? net.name : networkId.slice(0, 8) + "…";
    }

    function renderNetworkLink(networkId) {
      if (!networkId) return '<span class="dim">-</span>';
      const name = resolveNetworkName(networkId);
      return `<span class="resource-link" data-nav-to="network" data-hl-net="${escapeHtml(networkId)}" title="Lihat network">${escapeHtml(name)}</span>`;
    }

    async function loadData() {
      const [dbRes, netRes] = await Promise.all([
        apis.database.list(),
        apis.network.listNetworks(),
      ]);
      databases = dbRes.databases || [];
      networks = netRes.networks || [];
    }

    function render() {
      let filtered = databases;
      if (activeWs) {
        filtered = databases.filter((d) => d.network_id === activeWs);
      }

      root.innerHTML = `
        <section class="panel">
          <div class="panel-header">
            <h3>Databases${activeWs ? " in Workspace" : ""}</h3>
            <button id="rds-create-btn" class="btn btn-primary btn-inline">+ Create Database</button>
          </div>

          ${filtered.length === 0
            ? `<div class="empty-state" style="padding:24px 0;">
                <div class="empty-icon"><img src="/assets/icons/database.png" alt="" width="40" height="40" style="opacity:0.5;" /></div>
                <p>Belum ada database${activeWs ? " di workspace ini" : ""}.</p>
                <button class="btn btn-primary btn-inline" id="rds-create-btn-empty">+ Create Database</button>
              </div>`
            : `<div class="table-wrap"><table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Engine</th>
                  <th>Status</th>
                  <th>IP Address</th>
                  <th>Network</th>
                  <th>Public</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${filtered.map((d) => `
                  <tr>
                    <td><strong>${escapeHtml(d.name)}</strong></td>
                    <td class="muted">${escapeHtml(d.engine)}</td>
                    <td>${statusBadge(d.status)}</td>
                    <td><code class="mono" style="font-size:12px;">${escapeHtml(d.ip_address || "-")}</code></td>
                    <td>${renderNetworkLink(d.network_id)}</td>
                    <td>${d.public_hostname
                      ? `<span class="badge badge-blue">port ${d.expose_port}</span>`
                      : `<span class="dim">—</span>`
                    }</td>
                    <td class="muted">${toLocalDate(d.created_at)}</td>
                    <td>
                      <div class="actions">
                        <button class="btn btn-inline rds-detail-btn" data-id="${d.id}">Detail</button>
                        ${d.status === "available" ? `<button class="btn btn-inline rds-stop-btn" data-id="${d.id}">Stop</button>` : ""}
                        ${d.status === "stopped" ? `<button class="btn btn-inline btn-success rds-start-btn" data-id="${d.id}">Start</button>` : ""}
                        <button class="btn btn-inline btn-danger rds-delete-btn" data-id="${d.id}" data-name="${escapeHtml(d.name)}">Delete</button>
                      </div>
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table></div>`
          }
        </section>
      `;

      // ── Event bindings ──
      document.getElementById("rds-create-btn")?.addEventListener("click", showCreateModal);
      document.getElementById("rds-create-btn-empty")?.addEventListener("click", showCreateModal);

      root.querySelectorAll(".rds-detail-btn").forEach((btn) => {
        btn.addEventListener("click", () => showDetailModal(btn.dataset.id));
      });
      root.querySelectorAll(".rds-stop-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try {
            await apis.database.action(btn.dataset.id, "stop");
            toast("Database stopping...");
            await loadData();
            render();
          } catch (e) { toast(errMsg(e), "error"); }
        });
      });
      root.querySelectorAll(".rds-start-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try {
            await apis.database.action(btn.dataset.id, "start");
            toast("Database starting...");
            await loadData();
            render();
          } catch (e) { toast(errMsg(e), "error"); }
        });
      });
      root.querySelectorAll(".rds-delete-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!confirm(`Hapus database "${btn.dataset.name}"? Data akan hilang permanen.`)) return;
          try {
            await apis.database.delete(btn.dataset.id);
            toast("Database dihapus.");
            await loadData();
            render();
          } catch (e) { toast(errMsg(e), "error"); }
        });
      });

      // Cross-navigation
      root.querySelectorAll("[data-nav-to]").forEach((link) => {
        link.addEventListener("click", () => {
          if (link.dataset.hlNet) {
            state.activeWorkspace = link.dataset.hlNet;
            const sel = document.getElementById("workspace-select");
            if (sel) sel.value = link.dataset.hlNet;
          }
          navigate(link.dataset.navTo);
        });
      });
    }

    // ── Create modal ──
    function showCreateModal() {
      const networkOptions = networks
        .filter((n) => !activeWs || n.id === activeWs)
        .map((n) => `<option value="${n.id}"${activeWs === n.id ? " selected" : ""}>${escapeHtml(n.name)} (${n.cidr || "auto"})</option>`)
        .join("");

      const modal = showModal({
        title: "Create Database",
        bodyHtml: `
          <div class="stack-md">
            <div>
              <label class="field-label">Name</label>
              <input id="rds-name" type="text" placeholder="my-app-db" required />
            </div>
            <div>
              <label class="field-label">Engine</label>
              <select id="rds-engine">
                <option value="postgresql-16" selected>PostgreSQL 16</option>
              </select>
            </div>
            <div>
              <label class="field-label">Network</label>
              <select id="rds-network">${networkOptions || '<option value="">No networks available</option>'}</select>
            </div>
            <p class="muted" style="font-size:12px;">Database akan ditempatkan di network yang dipilih. Instance di network yang sama bisa mengakses via IP internal.</p>
          </div>
        `,
        actions: [
          {
            label: "Create",
            className: "btn btn-primary",
            onClick: async ({ close }) => {
              const name = modal.wrapper.querySelector("#rds-name").value.trim();
              const engine = modal.wrapper.querySelector("#rds-engine").value;
              const networkId = modal.wrapper.querySelector("#rds-network").value;
              if (!name) { toast("Nama wajib diisi", "error"); return; }
              try {
                await apis.database.create({ name, engine, network_id: networkId });
                toast("Database berhasil dibuat!");
                close();
                await loadData();
                render();
              } catch (e) { toast(errMsg(e), "error"); }
            },
          },
        ],
      });
    }

    // ── Detail modal ──
    async function showDetailModal(dbId) {
      let detail;
      try {
        detail = await apis.database.get(dbId);
      } catch (e) { toast(errMsg(e), "error"); return; }

      const isAvailable = detail.status === "available";
      const isStopped = detail.status === "stopped";

      const modal = showModal({
        title: `Database: ${detail.name}`,
        bodyHtml: `
          <div class="grid grid-2" style="gap:20px;">
            <div>
              <h4 style="margin:0 0 12px;font-size:14px;color:var(--text-secondary);">Connection Info</h4>
              <div class="stack-sm">
                <div class="field-row"><span class="muted">Host</span><code class="mono" style="font-size:12px;">${escapeHtml(detail.ip_address || "pending")}</code></div>
                <div class="field-row"><span class="muted">Port</span><code class="mono">${detail.port}</code></div>
                <div class="field-row"><span class="muted">Database</span><code class="mono">${escapeHtml(detail.db_name)}</code></div>
                <div class="field-row"><span class="muted">Username</span><code class="mono">${escapeHtml(detail.db_user)}</code></div>
                <div class="field-row">
                  <span class="muted">Password</span>
                  <span style="display:flex;align-items:center;gap:4px;">
                    <code class="mono" id="modal-db-pw">${escapeHtml(detail.db_password)}</code>
                    <button class="btn btn-xs btn-ghost modal-copy-btn" data-text="${escapeHtml(detail.db_password)}" data-label="Password"><img src="/assets/icons/copy.png" alt="" width="14" height="14" style="vertical-align:middle;" /></button>
                  </span>
                </div>
                <hr style="border-color:var(--border-subtle);margin:6px 0;" />
                <div>
                  <span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Connection String</span>
                  <div style="display:flex;gap:4px;align-items:center;margin-top:4px;">
                    <code style="font-size:11px;word-break:break-all;flex:1;">${escapeHtml(detail.connection_string)}</code>
                    <button class="btn btn-xs btn-ghost modal-copy-btn" data-text="${escapeHtml(detail.connection_string)}" data-label="Connection string"><img src="/assets/icons/copy.png" alt="" width="14" height="14" style="vertical-align:middle;" /></button>
                  </div>
                </div>
                <div>
                  <span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Async Connection String</span>
                  <div style="display:flex;gap:4px;align-items:center;margin-top:4px;">
                    <code style="font-size:11px;word-break:break-all;flex:1;">${escapeHtml(detail.connection_string_async)}</code>
                    <button class="btn btn-xs btn-ghost modal-copy-btn" data-text="${escapeHtml(detail.connection_string_async)}" data-label="Async connection string"><img src="/assets/icons/copy.png" alt="" width="14" height="14" style="vertical-align:middle;" /></button>
                  </div>
                </div>
                ${detail.public_url ? `
                <div>
                  <span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Public Connection</span>
                  <div style="display:flex;gap:4px;align-items:center;margin-top:4px;">
                    <code style="font-size:11px;word-break:break-all;flex:1;">${escapeHtml(detail.public_url)}</code>
                    <button class="btn btn-xs btn-ghost modal-copy-btn" data-text="${escapeHtml(detail.public_url)}" data-label="Public URL"><img src="/assets/icons/copy.png" alt="" width="14" height="14" style="vertical-align:middle;" /></button>
                  </div>
                </div>
                ` : ""}
              </div>
            </div>
            <div>
              <h4 style="margin:0 0 12px;font-size:14px;color:var(--text-secondary);">Details & Actions</h4>
              <div class="stack-sm">
                <div class="field-row"><span class="muted">ID</span><code style="font-size:11px;">${escapeHtml(detail.id)}</code></div>
                <div class="field-row"><span class="muted">Engine</span><span>${escapeHtml(detail.engine)}</span></div>
                <div class="field-row"><span class="muted">Network</span><span>${resolveNetworkName(detail.network_id)}</span></div>
                <div class="field-row"><span class="muted">Public DNS</span><span>${escapeHtml(detail.public_hostname || "—")}</span></div>
                <div class="field-row"><span class="muted">Created</span><span>${toLocalDate(detail.created_at)}</span></div>
              </div>
              <h4 style="margin:16px 0 8px;font-size:14px;color:var(--text-secondary);">Actions</h4>
              <div style="display:flex;flex-wrap:wrap;gap:6px;">
                ${isAvailable ? `<button class="btn btn-inline modal-action" data-action="stop">⏹ Stop</button>
                  <button class="btn btn-inline modal-action" data-action="reboot"><img src="/assets/icons/reboot.png" alt="" width="14" height="14" style="vertical-align:middle;" /> Reboot</button>` : ""}
                ${isStopped ? `<button class="btn btn-inline btn-success modal-action" data-action="start">▶ Start</button>` : ""}
                ${isAvailable ? `<button class="btn btn-inline modal-reset-pw"><img src="/assets/icons/reset-password.png" alt="" width="14" height="14" style="vertical-align:middle;" /> Reset Password</button>` : ""}
                ${isAvailable && !detail.public_hostname ? `<button class="btn btn-inline modal-expose"><img src="/assets/icons/expose.png" alt="" width="14" height="14" style="vertical-align:middle;" /> Expose Public</button>` : ""}
                ${detail.public_hostname ? `<button class="btn btn-inline btn-danger modal-unexpose"><img src="/assets/icons/unexpose.png" alt="" width="14" height="14" style="vertical-align:middle;" /> Unexpose</button>` : ""}
              </div>
              ${detail.error_message ? `<div class="message error" style="margin-top:12px;">${escapeHtml(detail.error_message)}</div>` : ""}
            </div>
          </div>
        `,
      });

      // Copy buttons
      modal.wrapper.querySelectorAll(".modal-copy-btn").forEach((btn) => {
        btn.addEventListener("click", () => copyText(btn.dataset.text, btn.dataset.label));
      });

      // Action buttons
      modal.wrapper.querySelectorAll(".modal-action").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            await apis.database.action(dbId, btn.dataset.action);
            toast(`Database ${btn.dataset.action} berhasil`);
            modal.close();
            await loadData();
            render();
          } catch (e) {
            toast(errMsg(e), "error");
            btn.disabled = false;
          }
        });
      });

      // Reset password
      modal.wrapper.querySelector(".modal-reset-pw")?.addEventListener("click", async () => {
        if (!confirm("Reset password database? Connection string akan berubah.")) return;
        try {
          await apis.database.resetPassword(dbId);
          toast("Password berhasil direset");
          modal.close();
          await loadData();
          render();
        } catch (e) { toast(errMsg(e), "error"); }
      });

      // Expose
      modal.wrapper.querySelector(".modal-expose")?.addEventListener("click", async () => {
        try {
          await apis.database.expose(dbId);
          toast("Database berhasil di-expose!");
          modal.close();
          await loadData();
          render();
        } catch (e) { toast(errMsg(e), "error"); }
      });

      // Unexpose
      modal.wrapper.querySelector(".modal-unexpose")?.addEventListener("click", async () => {
        try {
          await apis.database.unexpose(dbId);
          toast("Database tidak lagi public");
          modal.close();
          await loadData();
          render();
        } catch (e) { toast(errMsg(e), "error"); }
      });
    }

    // ── Init ──
    await loadData();
    render();
  },
};
