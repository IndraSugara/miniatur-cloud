import { REFRESH_MS } from "../config.js";
import { createOptionList, escapeHtml, statusClass, toLocalDate, withLoading } from "../utils.js";
import { showModal, toast } from "../ui.js";

function extractMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function renderTags(tags) {
  if (!tags || Object.keys(tags).length === 0) return '<span class="dim">—</span>';
  return Object.entries(tags)
    .map(([k, v]) => `<span class="chip mono" style="font-size:0.75rem;">${escapeHtml(k)}=${escapeHtml(v)}</span>`)
    .join(" ");
}

export const computeView = {
  id: "compute",
  title: "Instances",
  subtitle: "Kelola instance, tindakan lifecycle, SSH, exec, logs, dan snapshot.",
  async mount(root, { apis, navigate, state }) {
    const activeWs = state.activeWorkspace;
    root.innerHTML = `
      <section class="panel">
        <div class="panel-header">
          <h3>Launch Instance</h3>
        </div>
        <form id="create-instance-form" class="stack-md">
          <div class="grid grid-3">
            <div>
              <label class="field-label" for="inst-name">Name</label>
              <input id="inst-name" required placeholder="web-01" />
            </div>
            <div>
              <label class="field-label" for="inst-image">Image</label>
              <select id="inst-image"></select>
            </div>
            <div>
              <label class="field-label" for="inst-type">Instance Type</label>
              <select id="inst-type"></select>
            </div>
          </div>
          <div class="grid grid-3">
            <div>
              <label class="field-label" for="inst-network">Network</label>
              <select id="inst-network">
                <option value="">Default</option>
              </select>
            </div>
            <div>
              <label class="field-label" for="inst-sg">Security Group</label>
              <select id="inst-sg">
                <option value="">Default</option>
              </select>
            </div>
            <div>
              <label class="field-label" for="inst-ep">Public Endpoint</label>
              <select id="inst-ep">
                <option value="">Auto SSH Port</option>
              </select>
            </div>
          </div>
          <div>
            <label class="field-label" for="inst-tags">Tags <span class="muted">(key=value, comma separated)</span></label>
            <input id="inst-tags" placeholder="env=dev, project=demo" />
          </div>
          <div class="toolbar">
            <button id="create-instance-btn" class="btn btn-primary" type="submit"><img src="/assets/icons/launch.png" alt="" width="16" height="16" style="vertical-align:middle;" /> Launch Instance</button>
          </div>
        </form>
        <p id="create-instance-message" class="message hidden"></p>
      </section>

      <section class="panel">
        <div class="panel-header">
          <h3>Instances</h3>
          <button id="reload-instances" class="btn btn-inline btn-ghost">↻ Reload</button>
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
                <th>Public URL</th>
                <th>SSH/Endpoint</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="instance-body">
              <tr><td colspan="9" class="dim"><span class="spinner"></span> Memuat instance…</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <h3>Snapshots</h3>
          <button id="reload-snapshots" class="btn btn-inline btn-ghost">↻ Reload</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Source Instance</th>
                <th>Image Ref</th>
                <th>Created</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody id="snapshot-body">
              <tr><td colspan="5" class="dim"><span class="spinner"></span> Memuat snapshot…</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    `;

    const form = root.querySelector("#create-instance-form");
    const createBtn = root.querySelector("#create-instance-btn");
    const messageEl = root.querySelector("#create-instance-message");
    const instanceBody = root.querySelector("#instance-body");
    const snapshotBody = root.querySelector("#snapshot-body");

    const imageSelect = root.querySelector("#inst-image");
    const typeSelect = root.querySelector("#inst-type");
    const networkSelect = root.querySelector("#inst-network");
    const sgSelect = root.querySelector("#inst-sg");
    const epSelect = root.querySelector("#inst-ep");
    const tagsInput = root.querySelector("#inst-tags");

    let instances = [];
    let networkList = [];
    let securityGroups = [];
    let publicEndpoints = [];

    function parseTags(raw) {
      if (!raw || !raw.trim()) return null;
      const result = {};
      raw.split(",").forEach((pair) => {
        const [k, ...rest] = pair.split("=");
        const key = (k || "").trim();
        const val = rest.join("=").trim();
        if (key) result[key] = val || "";
      });
      return Object.keys(result).length > 0 ? result : null;
    }

    async function loadCreateDependencies() {
      const [imagesPayload, typesPayload, netsPayload, sgsPayload, epsPayload] = await Promise.all([
        apis.catalog.images(),
        apis.catalog.types(),
        apis.network.listNetworks(),
        apis.network.listSecurityGroups(),
        apis.network.listPublicEndpoints(),
      ]);
      const images = imagesPayload.images || [];
      const types = typesPayload.instance_types || {};
      networkList = netsPayload.networks || [];
      securityGroups = sgsPayload.security_groups || [];
      publicEndpoints = epsPayload.public_endpoints || [];

      imageSelect.innerHTML = images
        .map((img) => {
          const key = typeof img === "string" ? img : img.key;
          const desc = typeof img === "object" && img.description ? ` — ${img.description}` : "";
          return `<option value="${key}">${key}${desc}</option>`;
        })
        .join("");

      typeSelect.innerHTML = Object.entries(types)
        .map(
          ([key, value]) => {
            const gpuBadge = value.gpu ? " [GPU]" : "";
            const desc = value.description ? ` — ${value.description}` : "";
            return `<option value="${key}">${key} (${value.vcpu} vCPU / ${value.memory_mb} MB${gpuBadge})${desc}</option>`;
          },
        )
        .join("");

      networkSelect.innerHTML = `<option value="">Default</option>${createOptionList(
        networkList,
        (item) => `${item.name} (${item.cidr || "-"})`,
        (item) => item.id,
      )}`;
      sgSelect.innerHTML = `<option value="">Default</option>${createOptionList(
        securityGroups,
        (item) => `${item.name}${item.is_default ? " [default]" : ""}`,
        (item) => item.id,
      )}`;
      epSelect.innerHTML = `<option value="">Auto SSH Port</option>${createOptionList(
        publicEndpoints.filter((ep) => ep.status === "available"),
        (item) => `${item.public_ip}:${item.public_port}`,
        (item) => item.id,
      )}`;
    }

    function resolveNetworkName(networkId) {
      if (!networkId) return "-";
      const net = networkList.find((n) => n.id === networkId);
      return net ? net.name : networkId.slice(0, 8) + "…";
    }

    function renderNetworkLink(networkId) {
      if (!networkId) return '<span class="dim">-</span>';
      const name = resolveNetworkName(networkId);
      return `<span class="resource-link" data-nav-to="network" data-hl-net="${escapeHtml(networkId)}" title="Lihat network">${escapeHtml(name)}</span>`;
    }

    function renderStatusBadge(item) {
      let badge = `<span class="status ${statusClass(item.status)}">${item.status}</span>`;
      if (item.status_detail && item.status !== "running" && item.status !== "terminated") {
        badge += `<div class="muted" style="font-size:0.75rem;margin-top:2px;">${escapeHtml(item.status_detail)}</div>`;
      }
      if (item.status === "error" && item.error_message) {
        badge += `<div class="muted" style="font-size:0.7rem;color:var(--danger);margin-top:2px;" title="${escapeHtml(item.error_message)}">${escapeHtml(item.error_message.slice(0, 40))}${item.error_message.length > 40 ? "…" : ""}</div>`;
      }
      return badge;
    }

    function renderInstances() {
      let filtered = instances;
      if (activeWs) {
        filtered = instances.filter((i) => i.network_id === activeWs);
      }
      if (filtered.length === 0) {
        instanceBody.innerHTML = `<tr><td colspan="9" class="dim">Belum ada instance${activeWs ? " di workspace ini" : ""}.</td></tr>`;
        return;
      }
      instanceBody.innerHTML = filtered
        .map(
          (item) => `
            <tr>
              <td><strong>${escapeHtml(item.name)}</strong></td>
              <td>${renderStatusBadge(item)}</td>
              <td>${escapeHtml(item.image)}</td>
              <td><span class="chip mono">${escapeHtml(item.instance_type)}</span></td>
              <td>${renderNetworkLink(item.network_id)}</td>
              <td>${item.public_url
                ? `<a href="${escapeHtml(item.public_url)}" target="_blank" class="mono resource-link" style="font-size:0.8rem;">${escapeHtml(item.public_hostname)}</a>`
                : '<span class="dim">—</span>'
              }</td>
              <td class="mono" style="font-size:12px;">${escapeHtml(item.public_endpoint || (item.ssh_port ? "port " + item.ssh_port : "-"))}</td>
              <td class="muted">${toLocalDate(item.created_at)}</td>
              <td>
                <div class="actions">
                  <button class="btn btn-inline" data-action="detail" data-id="${item.id}">Detail</button>
                  <button class="btn btn-inline" data-action="logs" data-id="${item.id}">Logs</button>
                  <button class="btn btn-inline" data-action="exec" data-id="${item.id}">Exec</button>
                  ${
                    item.status === "running"
                      ? `<button class="btn btn-inline" data-action="console" data-id="${item.id}">Console</button>`
                      : ""
                  }
                  ${
                    item.status === "running" && !item.public_url
                      ? `<button class="btn btn-inline btn-success" data-action="expose" data-id="${item.id}">Expose</button>`
                      : ""
                  }
                  ${
                    item.public_url
                      ? `<button class="btn btn-inline btn-danger" data-action="unexpose" data-id="${item.id}">Unexpose</button>`
                      : ""
                  }
                  <button class="btn btn-inline" data-action="snapshot" data-id="${item.id}">Snap</button>
                  ${
                    item.status === "running"
                      ? `<button class="btn btn-inline" data-action="stop" data-id="${item.id}">Stop</button>`
                      : ""
                  }
                  ${
                    item.status === "stopped"
                      ? `<button class="btn btn-inline btn-success" data-action="start" data-id="${item.id}">Start</button>`
                      : ""
                  }
                  ${
                    item.status === "running"
                      ? `<button class="btn btn-inline" data-action="reboot" data-id="${item.id}">Reboot</button>`
                      : ""
                  }
                  <button class="btn btn-inline btn-danger" data-action="terminate" data-id="${item.id}">Terminate</button>
                </div>
              </td>
            </tr>
          `,
        )
        .join("");
    }

    async function renderSnapshots() {
      const payload = await apis.compute.listSnapshots();
      const list = payload.snapshots || [];
      if (list.length === 0) {
        snapshotBody.innerHTML = `<tr><td colspan="5" class="dim">Belum ada snapshot.</td></tr>`;
        return;
      }
      snapshotBody.innerHTML = list
        .map(
          (item) => `
            <tr>
              <td><strong>${escapeHtml(item.name)}</strong></td>
              <td class="mono" style="font-size:12px;">${escapeHtml(item.source_instance_id)}</td>
              <td class="mono" style="font-size:12px;">${escapeHtml(item.image_ref)}</td>
              <td class="muted">${toLocalDate(item.created_at)}</td>
              <td>
                <button class="btn btn-inline btn-danger" data-snap-delete="${item.id}">Delete</button>
              </td>
            </tr>
          `,
        )
        .join("");
    }

    async function reloadAll() {
      const instancePayload = await apis.compute.listInstances();
      instances = instancePayload.instances || [];
      renderInstances();
      await renderSnapshots();
    }

    async function openDetailModal(instanceId) {
      const [detail, netsPayload, sgsPayload] = await Promise.all([
        apis.compute.getInstance(instanceId),
        apis.network.listNetworks(),
        apis.network.listSecurityGroups(),
      ]);
      const modal = showModal({
        title: `Instance — ${escapeHtml(detail.name)}`,
        bodyHtml: `
          <div class="grid grid-2">
            <div>
              <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Status</div>
              <div style="margin-top:4px;"><span class="status ${statusClass(detail.status)}">${detail.status}</span></div>
              ${detail.status_detail ? `<div class="muted" style="font-size:0.8rem;">${escapeHtml(detail.status_detail)}</div>` : ""}
              ${detail.error_message ? `<div style="font-size:0.8rem;color:var(--danger);">${escapeHtml(detail.error_message)}</div>` : ""}
            </div>
            <div>
              <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Type</div>
              <div style="margin-top:4px;"><span class="chip mono">${escapeHtml(detail.instance_type)}</span></div>
            </div>
            <div>
              <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">IP Address</div>
              <div class="mono" style="margin-top:4px;">${escapeHtml(detail.ip_address || "-")}</div>
            </div>
            <div>
              <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">SSH Command</div>
              <div class="mono" style="margin-top:4px;font-size:12px;">${escapeHtml(detail.ssh_command || "-")}</div>
              ${detail.ssh_command_direct ? `<div class="muted" style="font-size:0.7rem;margin-top:4px;">Direct: ${escapeHtml(detail.ssh_command_direct)}</div>` : ""}
            </div>
            <div>
              <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">SSH Password</div>
              <div class="mono" style="margin-top:4px;">${escapeHtml(detail.ssh_password || "-")}</div>
            </div>
            <div>
              <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Public Endpoint</div>
              <div class="mono" style="margin-top:4px;">${escapeHtml(detail.public_endpoint || "-")}</div>
            </div>
            <div>
              <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">vCPU / RAM</div>
              <div class="mono" style="margin-top:4px;">${detail.vcpu || "-"} vCPU / ${detail.memory_mb || "-"} MB</div>
            </div>
            <div>
              <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Tags</div>
              <div style="margin-top:4px;">${renderTags(detail.tags)}</div>
            </div>
            <div style="grid-column:1/-1;">
              <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Public URL</div>
              <div style="margin-top:4px;">${detail.public_url
                ? `<a href="${escapeHtml(detail.public_url)}" target="_blank" class="resource-link">${escapeHtml(detail.public_url)}</a> <span class="muted">(port ${detail.expose_port})</span>`
                : '<span class="dim">Not exposed</span>'
              }</div>
            </div>
          </div>
          <div style="margin-top:14px;padding:12px;border:1px solid var(--border);border-radius:var(--radius-sm);">
            <div class="muted" style="margin-bottom:8px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Expose App to Internet</div>
            ${detail.public_url ? `
              <div style="display:flex;align-items:center;gap:8px;">
                <span class="mono" style="font-size:0.85rem;"><img src="/assets/icons/public-url.png" alt="" width="14" height="14" style="vertical-align:middle;" /> <a href="${escapeHtml(detail.public_url)}" target="_blank" class="resource-link">${escapeHtml(detail.public_hostname)}</a></span>
                <span class="muted">→ port ${detail.expose_port}</span>
                <button id="modal-unexpose" class="btn btn-inline btn-danger">Unexpose</button>
              </div>
            ` : `
              <div class="grid grid-2" style="gap:8px;align-items:end;">
                <div>
                  <label class="field-label" style="font-size:10px;">App Port (e.g. 3000, 8080)</label>
                  <input id="modal-expose-port" type="number" min="1" max="65535" value="8080" />
                </div>
                <div>
                  <button id="modal-expose-btn" class="btn btn-primary" style="width:100%;">Expose</button>
                </div>
              </div>
            `}
          </div>
          <div id="instance-metrics" style="margin-top:14px;">
            <div class="dim"><span class="spinner"></span> Memuat metrics…</div>
          </div>
          <hr style="border-color:var(--border-subtle);margin:16px 0;" />
          <div class="grid grid-2">
            <div>
              <label class="field-label">Ubah Network</label>
              <select id="modal-network">${createOptionList(
                netsPayload.networks || [],
                (item) => `${item.name} (${item.cidr || "-"})`,
                (item) => item.id,
                detail.network_id,
              )}</select>
              <button id="modal-apply-network" class="btn btn-inline" style="margin-top:8px;">Apply</button>
            </div>
            <div>
              <label class="field-label">Ubah Security Group</label>
              <select id="modal-sg">${createOptionList(
                sgsPayload.security_groups || [],
                (item) => `${item.name}${item.is_default ? " [default]" : ""}`,
                (item) => item.id,
                detail.security_group_id,
              )}</select>
              <button id="modal-apply-sg" class="btn btn-inline" style="margin-top:8px;">Apply</button>
            </div>
          </div>
          <hr style="border-color:var(--border-subtle);margin:16px 0;" />
          <div>
            <label class="field-label">Edit Tags <span class="muted">(key=value, comma separated)</span></label>
            <input id="modal-tags-input" value="${escapeHtml(
              detail.tags ? Object.entries(detail.tags).map(([k, v]) => `${k}=${v}`).join(", ") : ""
            )}" />
            <button id="modal-apply-tags" class="btn btn-inline" style="margin-top:8px;">Save Tags</button>
          </div>
          <p id="modal-detail-message" class="message hidden" style="margin-top:10px;"></p>
        `,
      });

      const modalRoot = modal.wrapper;
      const msg = modalRoot.querySelector("#modal-detail-message");
      const applyNetworkBtn = modalRoot.querySelector("#modal-apply-network");
      const applySgBtn = modalRoot.querySelector("#modal-apply-sg");
      const applyTagsBtn = modalRoot.querySelector("#modal-apply-tags");

      // Fetch instance metrics asynchronously
      const metricsBox = modalRoot.querySelector("#instance-metrics");
      if (detail.status === "running") {
        apis.compute.getInstanceStatus(instanceId).then((stats) => {
          const cpuPct = stats.cpu_percent != null ? stats.cpu_percent.toFixed(1) : "N/A";
          const memUsed = stats.mem_usage_mb != null ? stats.mem_usage_mb.toFixed(0) : "-";
          const memLimit = stats.mem_limit_mb != null ? stats.mem_limit_mb.toFixed(0) : "-";
          const memPct = (stats.mem_usage_mb && stats.mem_limit_mb)
            ? ((stats.mem_usage_mb / stats.mem_limit_mb) * 100).toFixed(0) : 0;
          metricsBox.innerHTML = `
            <div class="grid grid-2" style="gap:10px;">
              <div class="metric">
                <div class="label">CPU</div>
                <div class="value" style="font-size:20px;">${cpuPct}%</div>
                <div class="progress${cpuPct > 80 ? ' danger' : cpuPct > 60 ? ' warn' : ''}"><span style="width:${Math.min(cpuPct, 100)}%;"></span></div>
              </div>
              <div class="metric">
                <div class="label">Memory</div>
                <div class="value" style="font-size:20px;">${memUsed} / ${memLimit} MB</div>
                <div class="progress${memPct > 80 ? ' danger' : memPct > 60 ? ' warn' : ''}"><span style="width:${Math.min(memPct, 100)}%;"></span></div>
              </div>
            </div>
          `;
        }).catch(() => {
          metricsBox.innerHTML = `<div class="muted" style="font-size:0.85rem;">Metrics tidak tersedia.</div>`;
        });
      } else {
        metricsBox.innerHTML = `<div class="muted" style="font-size:0.85rem;">Metrics hanya tersedia untuk instance running.</div>`;
      }

      applyNetworkBtn.addEventListener("click", async () => {
        try {
          await withLoading(applyNetworkBtn, "Applying...", async () => {
            const selected = modalRoot.querySelector("#modal-network").value;
            await apis.compute.updateNetwork(instanceId, selected);
          });
          msg.className = "message ok";
          msg.textContent = "Network berhasil diupdate.";
          await reloadAll();
        } catch (error) {
          msg.className = "message error";
          msg.textContent = extractMessage(error);
        }
      });

      applySgBtn.addEventListener("click", async () => {
        try {
          await withLoading(applySgBtn, "Applying...", async () => {
            const selected = modalRoot.querySelector("#modal-sg").value;
            await apis.compute.updateSecurityGroup(instanceId, selected);
          });
          msg.className = "message ok";
          msg.textContent = "Security group berhasil diupdate.";
          await reloadAll();
        } catch (error) {
          msg.className = "message error";
          msg.textContent = extractMessage(error);
        }
      });

      applyTagsBtn.addEventListener("click", async () => {
        try {
          const raw = modalRoot.querySelector("#modal-tags-input").value;
          const tags = {};
          if (raw.trim()) {
            raw.split(",").forEach((pair) => {
              const [k, ...rest] = pair.split("=");
              const key = (k || "").trim();
              const val = rest.join("=").trim();
              if (key) tags[key] = val || "";
            });
          }
          await apis.compute.updateTags(instanceId, tags);
          msg.className = "message ok";
          msg.textContent = "Tags berhasil diupdate.";
          await reloadAll();
        } catch (error) {
          msg.className = "message error";
          msg.textContent = extractMessage(error);
        }
      });

      // Expose / Unexpose handlers
      const exposeBtn = modalRoot.querySelector("#modal-expose-btn");
      const unexposeBtn = modalRoot.querySelector("#modal-unexpose");

      if (exposeBtn) {
        exposeBtn.addEventListener("click", async () => {
          const port = parseInt(modalRoot.querySelector("#modal-expose-port").value);
          if (!port || port < 1 || port > 65535) {
            msg.className = "message error";
            msg.textContent = "Port harus antara 1 dan 65535.";
            return;
          }
          try {
            const result = await withLoading(exposeBtn, "Exposing...", async () =>
              apis.compute.expose(instanceId, port)
            );
            toast(`Instance exposed: ${result.public_url}`);
            modal.close();
            await reloadAll();
          } catch (error) {
            msg.className = "message error";
            msg.textContent = extractMessage(error);
          }
        });
      }

      if (unexposeBtn) {
        unexposeBtn.addEventListener("click", async () => {
          try {
            await withLoading(unexposeBtn, "Removing...", async () =>
              apis.compute.unexpose(instanceId)
            );
            toast("Public URL dihapus.");
            modal.close();
            await reloadAll();
          } catch (error) {
            msg.className = "message error";
            msg.textContent = extractMessage(error);
          }
        });
      }
    }

    async function openLogsModal(instanceId) {
      const modal = showModal({
        title: `Container Logs — ${instanceId.slice(0, 8)}`,
        bodyHtml: `
          <div class="toolbar" style="margin-bottom:8px;">
            <label class="field-label" style="margin:0;">Tail lines:</label>
            <select id="log-tail" style="width:auto;margin-left:8px;">
              <option value="50">50</option>
              <option value="100" selected>100</option>
              <option value="300">300</option>
              <option value="500">500</option>
            </select>
            <button id="log-refresh" class="btn btn-inline btn-ghost" style="margin-left:8px;">↻ Refresh</button>
          </div>
          <pre id="log-output" class="mono" style="min-height:200px;max-height:400px;overflow:auto;font-size:0.8rem;white-space:pre-wrap;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;"><span class="spinner"></span> Loading logs…</pre>
        `,
      });
      const output = modal.wrapper.querySelector("#log-output");
      const tailSelect = modal.wrapper.querySelector("#log-tail");
      const refreshBtn = modal.wrapper.querySelector("#log-refresh");

      async function loadLogs() {
        output.innerHTML = '<span class="spinner"></span> Loading logs…';
        try {
          const result = await apis.compute.getInstanceLogs(instanceId, parseInt(tailSelect.value));
          output.textContent = result.logs || "(no output)";
          output.scrollTop = output.scrollHeight;
        } catch (error) {
          output.textContent = extractMessage(error);
        }
      }

      await loadLogs();
      refreshBtn.addEventListener("click", loadLogs);
      tailSelect.addEventListener("change", loadLogs);
    }

    async function openExecModal(instanceId) {
      const modal = showModal({
        title: `Exec Command — ${instanceId.slice(0, 8)}`,
        bodyHtml: `
          <div class="stack-md">
            <div>
              <label class="field-label">Command</label>
              <input id="exec-command" value="uname -a" />
            </div>
            <button id="run-exec" class="btn btn-primary btn-inline">▶ Run</button>
            <pre id="exec-output" class="mono" style="min-height:120px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;font-size:0.8rem;white-space:pre-wrap;">-</pre>
          </div>
        `,
      });
      const runBtn = modal.wrapper.querySelector("#run-exec");
      const commandInput = modal.wrapper.querySelector("#exec-command");
      const output = modal.wrapper.querySelector("#exec-output");
      runBtn.addEventListener("click", async () => {
        await withLoading(runBtn, "Running...", async () => {
          const result = await apis.compute.exec(instanceId, commandInput.value);
          output.textContent = [result.stdout, result.stderr].filter(Boolean).join("\n") || "(no output)";
        }).catch((error) => {
          output.textContent = extractMessage(error);
        });
      });
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      messageEl.className = "message hidden";
      const payload = {
        name: root.querySelector("#inst-name").value.trim(),
        image: imageSelect.value,
        instance_type: typeSelect.value,
      };
      if (networkSelect.value) payload.network_id = networkSelect.value;
      if (sgSelect.value) payload.security_group_id = sgSelect.value;
      if (epSelect.value) payload.public_endpoint_id = epSelect.value;
      const tags = parseTags(tagsInput.value);
      if (tags) payload.tags = tags;

      if (!payload.name) {
        messageEl.className = "message error";
        messageEl.textContent = "Nama instance wajib diisi.";
        return;
      }

      try {
        const result = await withLoading(createBtn, "Launching...", async () => apis.compute.createInstance(payload));
        messageEl.className = "message ok";
        messageEl.textContent = `Instance sedang dibuat — ${result.status_detail || "queued"}`;
        form.reset();
        await loadCreateDependencies();
        await reloadAll();
      } catch (error) {
        messageEl.className = "message error";
        messageEl.textContent = extractMessage(error);
      }
    });

    root.querySelector("#reload-instances").addEventListener("click", () => {
      reloadAll().catch((error) => toast(extractMessage(error), "error"));
    });

    root.querySelector("#reload-snapshots").addEventListener("click", () => {
      renderSnapshots().catch((error) => toast(extractMessage(error), "error"));
    });

    instanceBody.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const action = target.dataset.action;
      const id = target.dataset.id;
      if (!action || !id) return;
      try {
        if (action === "detail") {
          await openDetailModal(id);
          return;
        }
        if (action === "logs") {
          await openLogsModal(id);
          return;
        }
        if (action === "exec") {
          await openExecModal(id);
          return;
        }
        if (action === "console") {
          const modal = showModal({
            title: `Web Terminal — ${id.slice(0, 8)}`,
            bodyHtml: `<div id="terminal-container" style="height: 400px; width: 100%; background: #000; border-radius: 4px; padding: 4px; overflow: hidden;"></div>`,
          });
          const termContainer = modal.wrapper.querySelector("#terminal-container");
          const term = new window.Terminal({
            cursorBlink: true,
            fontFamily: "monospace",
            fontSize: 14,
            theme: { background: "#000" }
          });
          const fitAddon = new window.FitAddon.FitAddon();
          term.loadAddon(fitAddon);
          term.open(termContainer);
          setTimeout(() => fitAddon.fit(), 50);

          const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
          const token = apis.auth.getToken();
          const wsUrl = `${protocol}//${window.location.host}/api/instances/${id}/terminal?token=${token}`;
          
          const ws = new WebSocket(wsUrl);
          let pingInterval;
          ws.onopen = () => {
             term.writeln('\\r\\n*** Connected to instance ***\\r\\n');
             pingInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                   ws.send("__PING__");
                }
             }, 30000);
          };
          ws.onmessage = (evt) => {
             term.write(evt.data);
          };
          term.onData((data) => {
             if (ws.readyState === WebSocket.OPEN) {
                ws.send(data);
             }
          });
          ws.onclose = () => {
             if (pingInterval) clearInterval(pingInterval);
             term.writeln('\\r\\n*** Disconnected ***\\r\\n');
          };
          ws.onerror = () => {
             term.writeln('\\r\\n*** Connection Error ***\\r\\n');
          };
          
          const oldClose = modal.close;
          modal.close = () => {
             if (pingInterval) clearInterval(pingInterval);
             if (ws.readyState === WebSocket.OPEN) ws.close();
             term.dispose();
             oldClose();
          };
          
          const resizeHandler = () => fitAddon.fit();
          window.addEventListener("resize", resizeHandler);
          const cleanupResize = () => window.removeEventListener("resize", resizeHandler);
          
          const modalCloseBtn = modal.wrapper.querySelector(".modal-close");
          if (modalCloseBtn) {
            modalCloseBtn.addEventListener("click", cleanupResize);
          }
          return;
        }
        if (action === "expose") {
          const port = window.prompt("Port yang dijalankan app di instance (contoh: 3000, 8080):", "8080");
          if (!port) return;
          const portNum = parseInt(port);
          if (!portNum || portNum < 1 || portNum > 65535) {
            toast("Port harus antara 1 dan 65535.", "error");
            return;
          }
          const result = await apis.compute.expose(id, portNum);
          toast(`Exposed: ${result.public_url}`);
          await reloadAll();
          return;
        }
        if (action === "unexpose") {
          if (!window.confirm("Hapus public URL dari instance ini?")) return;
          await apis.compute.unexpose(id);
          toast("Public URL dihapus.");
          await reloadAll();
          return;
        }
        if (action === "snapshot") {
          const modal = showModal({
            title: "Create Snapshot",
            bodyHtml: `
              <div class="stack-md">
                <div>
                  <label class="field-label" for="snap-name">Nama snapshot (opsional)</label>
                  <input id="snap-name" placeholder="my-snapshot" />
                </div>
              </div>
            `,
            actions: [
              {
                label: "Create",
                className: "btn btn-primary",
                onClick: async ({ close }) => {
                  const name = modal.wrapper.querySelector("#snap-name").value.trim();
                  try {
                    await apis.compute.createSnapshot(id, name || null);
                    toast("Snapshot berhasil dibuat.");
                    close();
                    await renderSnapshots();
                  } catch (err) {
                    toast(extractMessage(err), "error");
                  }
                },
              },
            ],
          });
          return;
        }
        if (action === "terminate") {
          const confirmed = window.confirm("Terminate instance ini?");
          if (!confirmed) return;
        }
        await apis.compute.action(id, action);
        toast(`Action ${action} dikirim.`);
        await reloadAll();
      } catch (error) {
        toast(extractMessage(error), "error");
      }
    });

    snapshotBody.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const snapshotId = target.dataset.snapDelete;
      if (!snapshotId) return;
      if (!window.confirm("Delete snapshot ini?")) return;
      try {
        await apis.compute.deleteSnapshot(snapshotId);
        toast("Snapshot dihapus.");
        await renderSnapshots();
      } catch (error) {
        toast(extractMessage(error), "error");
      }
    });

    // Cross-navigation: clicking a network link navigates to Network view
    instanceBody.addEventListener("click", (event) => {
      const link = event.target.closest("[data-nav-to]");
      if (!link) return;
      const targetView = link.dataset.navTo;
      if (link.dataset.hlNet) {
        state.activeWorkspace = link.dataset.hlNet;
        const sel = document.getElementById("workspace-select");
        if (sel) sel.value = link.dataset.hlNet;
      }
      navigate(targetView);
    });

    await loadCreateDependencies();
    await reloadAll();

    const timer = window.setInterval(() => {
      reloadAll().catch(() => {
        // ignore periodic refresh failure
      });
    }, REFRESH_MS);

    return () => window.clearInterval(timer);
  },
};
