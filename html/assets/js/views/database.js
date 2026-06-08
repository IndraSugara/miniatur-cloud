/**
 * Database (RDS) view — managed PostgreSQL databases.
 */

import { toast } from "../ui.js";

// ── Status badge helper ─────────────────────────────────────
function statusBadge(status) {
  const map = {
    available: "badge-green",
    creating: "badge-yellow",
    stopped: "badge-dim",
    deleting: "badge-yellow",
    error: "badge-red",
  };
  return `<span class="badge ${map[status] || "badge-dim"}">${status}</span>`;
}

// ── Copy to clipboard ───────────────────────────────────────
async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} disalin!`);
  } catch {
    // Fallback
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

  async mount(root, { apis, state }) {
    let databases = [];
    let networks = [];

    async function loadData() {
      const [dbRes, netRes] = await Promise.all([
        apis.database.list(),
        apis.network.listNetworks(),
      ]);
      databases = dbRes.databases || [];
      networks = netRes.networks || [];
    }

    function networkName(networkId) {
      const net = networks.find((n) => n.id === networkId);
      return net ? net.name : "-";
    }

    function renderList() {
      root.innerHTML = `
        <section class="panel">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
            <h3 style="margin:0;">Databases</h3>
            <button id="rds-create-btn" class="btn btn-primary">+ Create Database</button>
          </div>

          ${databases.length === 0
            ? `<p class="dim">Belum ada database. Klik "Create Database" untuk memulai.</p>`
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
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${databases.map((d) => `
                  <tr>
                    <td><strong>${d.name}</strong></td>
                    <td><span class="dim">${d.engine}</span></td>
                    <td>${statusBadge(d.status)}</td>
                    <td><code>${d.ip_address || "-"}</code></td>
                    <td>${networkName(d.network_id)}</td>
                    <td>${d.public_hostname
                      ? `<span class="badge badge-blue">${d.expose_port}</span>`
                      : `<span class="dim">—</span>`
                    }</td>
                    <td class="dim">${new Date(d.created_at).toLocaleDateString()}</td>
                    <td>
                      <button class="btn btn-inline rds-detail-btn" data-id="${d.id}">Detail</button>
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table></div>`
          }
        </section>
      `;

      // Create button
      document.getElementById("rds-create-btn")?.addEventListener("click", showCreateModal);

      // Detail buttons
      root.querySelectorAll(".rds-detail-btn").forEach((btn) => {
        btn.addEventListener("click", () => showDetail(btn.dataset.id));
      });
    }

    // ── Create modal ──────────────────────────────────────────
    function showCreateModal() {
      const networkOptions = networks.map((n) =>
        `<option value="${n.id}">${n.name} (${n.cidr || "auto"})</option>`
      ).join("");

      const modal = document.createElement("div");
      modal.className = "modal-backdrop";
      modal.innerHTML = `
        <div class="modal-card">
          <h3>Create Database</h3>
          <div class="stack-md">
            <label class="field-label">Name</label>
            <input id="rds-name" type="text" placeholder="my-app-db" required />

            <label class="field-label">Engine</label>
            <select id="rds-engine">
              <option value="postgresql-16" selected>PostgreSQL 16</option>
            </select>

            <label class="field-label">Network</label>
            <select id="rds-network">${networkOptions}</select>

            <p class="dim" style="font-size:12px;">Database akan ditempatkan di network yang dipilih. Instance di network yang sama bisa mengakses via IP internal.</p>

            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px;">
              <button id="rds-cancel" class="btn btn-ghost">Batal</button>
              <button id="rds-submit" class="btn btn-primary">Create</button>
            </div>
          </div>
        </div>
      `;
      document.getElementById("modal-root").appendChild(modal);

      document.getElementById("rds-cancel").addEventListener("click", () => modal.remove());
      modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });

      document.getElementById("rds-submit").addEventListener("click", async () => {
        const name = document.getElementById("rds-name").value.trim();
        const engine = document.getElementById("rds-engine").value;
        const networkId = document.getElementById("rds-network").value;

        if (!name) { toast("Nama wajib diisi", "error"); return; }

        const btn = document.getElementById("rds-submit");
        btn.disabled = true;
        btn.textContent = "Creating...";

        try {
          await apis.database.create({ name, engine, network_id: networkId });
          toast("Database berhasil dibuat!");
          modal.remove();
          await loadData();
          renderList();
        } catch (err) {
          toast(err.message, "error");
          btn.disabled = false;
          btn.textContent = "Create";
        }
      });
    }

    // ── Detail panel ──────────────────────────────────────────
    async function showDetail(dbId) {
      let detail;
      try {
        detail = await apis.database.get(dbId);
      } catch (err) {
        toast(err.message, "error");
        return;
      }

      const isAvailable = detail.status === "available";
      const isStopped = detail.status === "stopped";

      root.innerHTML = `
        <section class="panel">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
            <button id="rds-back" class="btn btn-ghost">← Back</button>
            <h3 style="margin:0;">${detail.name}</h3>
            ${statusBadge(detail.status)}
          </div>

          <div class="grid-2col" style="gap:16px;">
            <!-- Left: Connection Info -->
            <div class="panel" style="background:var(--bg-panel-alt,#1a1a2e);padding:16px;border-radius:8px;">
              <h4 style="margin-top:0;">Connection Info</h4>
              <div class="stack-sm">
                <div class="field-row">
                  <span class="dim">Host</span>
                  <code>${detail.ip_address || "pending"}</code>
                </div>
                <div class="field-row">
                  <span class="dim">Port</span>
                  <code>${detail.port}</code>
                </div>
                <div class="field-row">
                  <span class="dim">Database</span>
                  <code>${detail.db_name}</code>
                </div>
                <div class="field-row">
                  <span class="dim">Username</span>
                  <code>${detail.db_user}</code>
                </div>
                <div class="field-row">
                  <span class="dim">Password</span>
                  <code id="rds-pw">${detail.db_password}</code>
                  <button class="btn btn-inline btn-xs rds-copy-btn" data-text="${detail.db_password}" data-label="Password">📋</button>
                </div>

                <hr style="border-color:var(--border);margin:8px 0;" />

                <div>
                  <span class="dim" style="font-size:12px;">Connection String</span>
                  <div style="display:flex;gap:4px;align-items:center;margin-top:4px;">
                    <code style="font-size:11px;word-break:break-all;flex:1;">${detail.connection_string}</code>
                    <button class="btn btn-inline btn-xs rds-copy-btn" data-text="${detail.connection_string}" data-label="Connection string">📋</button>
                  </div>
                </div>

                <div>
                  <span class="dim" style="font-size:12px;">Async Connection String</span>
                  <div style="display:flex;gap:4px;align-items:center;margin-top:4px;">
                    <code style="font-size:11px;word-break:break-all;flex:1;">${detail.connection_string_async}</code>
                    <button class="btn btn-inline btn-xs rds-copy-btn" data-text="${detail.connection_string_async}" data-label="Async connection string">📋</button>
                  </div>
                </div>

                ${detail.public_url ? `
                <div>
                  <span class="dim" style="font-size:12px;">Public Connection</span>
                  <div style="display:flex;gap:4px;align-items:center;margin-top:4px;">
                    <code style="font-size:11px;word-break:break-all;flex:1;">${detail.public_url}</code>
                    <button class="btn btn-inline btn-xs rds-copy-btn" data-text="${detail.public_url}" data-label="Public URL">📋</button>
                  </div>
                </div>
                ` : ""}
              </div>
            </div>

            <!-- Right: Details + Actions -->
            <div class="panel" style="background:var(--bg-panel-alt,#1a1a2e);padding:16px;border-radius:8px;">
              <h4 style="margin-top:0;">Details</h4>
              <div class="stack-sm">
                <div class="field-row">
                  <span class="dim">ID</span>
                  <code style="font-size:11px;">${detail.id}</code>
                </div>
                <div class="field-row">
                  <span class="dim">Engine</span>
                  <span>${detail.engine}</span>
                </div>
                <div class="field-row">
                  <span class="dim">Network</span>
                  <span>${networkName(detail.network_id)}</span>
                </div>
                <div class="field-row">
                  <span class="dim">Public DNS</span>
                  <span>${detail.public_hostname || "—"}</span>
                </div>
                <div class="field-row">
                  <span class="dim">Public Port</span>
                  <span>${detail.expose_port || "—"}</span>
                </div>
                <div class="field-row">
                  <span class="dim">Created</span>
                  <span>${new Date(detail.created_at).toLocaleString()}</span>
                </div>
              </div>

              <h4>Actions</h4>
              <div style="display:flex;flex-wrap:wrap;gap:8px;">
                ${isAvailable ? `
                  <button class="btn btn-ghost rds-action" data-action="stop">⏹ Stop</button>
                  <button class="btn btn-ghost rds-action" data-action="reboot">🔄 Reboot</button>
                ` : ""}
                ${isStopped ? `
                  <button class="btn btn-primary rds-action" data-action="start">▶ Start</button>
                ` : ""}
                ${isAvailable ? `
                  <button id="rds-reset-pw" class="btn btn-ghost">🔑 Reset Password</button>
                ` : ""}
                ${isAvailable && !detail.public_hostname ? `
                  <button id="rds-expose" class="btn btn-ghost">🌐 Expose Public</button>
                ` : ""}
                ${detail.public_hostname ? `
                  <button id="rds-unexpose" class="btn btn-ghost">🔒 Unexpose</button>
                ` : ""}
                <button id="rds-delete" class="btn btn-danger">🗑 Delete</button>
              </div>

              ${detail.error_message ? `
                <div class="message error" style="margin-top:12px;">${detail.error_message}</div>
              ` : ""}
            </div>
          </div>
        </section>
      `;

      // Back button
      document.getElementById("rds-back").addEventListener("click", async () => {
        await loadData();
        renderList();
      });

      // Copy buttons
      root.querySelectorAll(".rds-copy-btn").forEach((btn) => {
        btn.addEventListener("click", () => copyText(btn.dataset.text, btn.dataset.label));
      });

      // Action buttons (start/stop/reboot)
      root.querySelectorAll(".rds-action").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            await apis.database.action(dbId, btn.dataset.action);
            toast(`Database ${btn.dataset.action} berhasil`);
            await showDetail(dbId);
          } catch (err) {
            toast(err.message, "error");
            btn.disabled = false;
          }
        });
      });

      // Reset password
      document.getElementById("rds-reset-pw")?.addEventListener("click", async () => {
        if (!confirm("Reset password database? Connection string akan berubah.")) return;
        try {
          const result = await apis.database.resetPassword(dbId);
          toast("Password berhasil direset");
          await showDetail(dbId);
        } catch (err) {
          toast(err.message, "error");
        }
      });

      // Expose
      document.getElementById("rds-expose")?.addEventListener("click", async () => {
        const btn = document.getElementById("rds-expose");
        btn.disabled = true;
        btn.textContent = "Exposing...";
        try {
          await apis.database.expose(dbId);
          toast("Database berhasil di-expose!");
          await showDetail(dbId);
        } catch (err) {
          toast(err.message, "error");
          btn.disabled = false;
          btn.textContent = "🌐 Expose Public";
        }
      });

      // Unexpose
      document.getElementById("rds-unexpose")?.addEventListener("click", async () => {
        const btn = document.getElementById("rds-unexpose");
        btn.disabled = true;
        try {
          await apis.database.unexpose(dbId);
          toast("Database tidak lagi public");
          await showDetail(dbId);
        } catch (err) {
          toast(err.message, "error");
          btn.disabled = false;
        }
      });

      // Delete
      document.getElementById("rds-delete")?.addEventListener("click", async () => {
        if (!confirm(`Hapus database "${detail.name}"? Data akan hilang permanen.`)) return;
        try {
          await apis.database.delete(dbId);
          toast("Database dihapus");
          await loadData();
          renderList();
        } catch (err) {
          toast(err.message, "error");
        }
      });
    }

    // ── Init ─────────────────────────────────────────────────
    await loadData();
    renderList();
  },
};
