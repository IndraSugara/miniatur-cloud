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
  title: "Compute",
  subtitle: "Kelola instance, tindakan lifecycle, SSH, exec, logs, dan snapshot.",
  async mount(root, { apis }) {
    root.innerHTML = `
      <section class="panel">
        <h3>Create Instance</h3>
        <form id="create-instance-form" class="grid grid-3">
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
            <label class="field-label" for="inst-ep">Public Endpoint (optional)</label>
            <select id="inst-ep">
              <option value="">Auto SSH Port</option>
            </select>
          </div>
          <div style="grid-column:1/-1;">
            <label class="field-label" for="inst-tags">Tags <span class="dim">(key=value, comma separated)</span></label>
            <input id="inst-tags" placeholder="env=dev, project=demo" />
          </div>
          <div style="grid-column:1/-1;" class="toolbar">
            <button id="create-instance-btn" class="btn btn-primary" type="submit">Create Instance</button>
            <span class="dim">Tip: pilih network/security-group di awal untuk kolaborasi compute-network.</span>
          </div>
        </form>
        <p id="create-instance-message" class="message hidden"></p>
      </section>

      <section class="panel">
        <div class="toolbar" style="justify-content:space-between;">
          <h3>Instances</h3>
          <button id="reload-instances" class="btn btn-inline btn-ghost">Reload</button>
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
                <th>SSH/Endpoint</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="instance-body">
              <tr><td colspan="8" class="dim"><span class="spinner"></span> Memuat instance…</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel">
        <div class="toolbar" style="justify-content:space-between;">
          <h3>Snapshots</h3>
          <button id="reload-snapshots" class="btn btn-inline btn-ghost">Reload</button>
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

    function renderStatusBadge(item) {
      let badge = `<span class="status ${statusClass(item.status)}">${item.status}</span>`;
      if (item.status_detail && item.status !== "running" && item.status !== "terminated") {
        badge += `<div class="dim" style="font-size:0.75rem;margin-top:2px;">${escapeHtml(item.status_detail)}</div>`;
      }
      if (item.status === "error" && item.error_message) {
        badge += `<div class="dim" style="font-size:0.7rem;color:var(--error);margin-top:2px;" title="${escapeHtml(item.error_message)}">${escapeHtml(item.error_message.slice(0, 40))}${item.error_message.length > 40 ? "…" : ""}</div>`;
      }
      return badge;
    }

    function renderInstances() {
      if (instances.length === 0) {
        instanceBody.innerHTML = `<tr><td colspan="8" class="dim">Belum ada instance.</td></tr>`;
        return;
      }
      instanceBody.innerHTML = instances
        .map(
          (item) => `
            <tr>
              <td>${escapeHtml(item.name)}</td>
              <td>${renderStatusBadge(item)}</td>
              <td>${escapeHtml(item.image)}</td>
              <td><span class="chip mono">${escapeHtml(item.instance_type)}</span></td>
              <td class="mono">${escapeHtml(resolveNetworkName(item.network_id))}</td>
              <td class="mono">${escapeHtml(item.public_endpoint || (item.ssh_port ? "port " + item.ssh_port : "-"))}</td>
              <td>${toLocalDate(item.created_at)}</td>
              <td>
                <div class="actions">
                  <button class="btn btn-inline" data-action="detail" data-id="${item.id}">Detail</button>
                  <button class="btn btn-inline" data-action="logs" data-id="${item.id}">Logs</button>
                  <button class="btn btn-inline" data-action="exec" data-id="${item.id}">Exec</button>
                  <button class="btn btn-inline" data-action="snapshot" data-id="${item.id}">Snapshot</button>
                  ${
                    item.status === "running"
                      ? `<button class="btn btn-inline" data-action="stop" data-id="${item.id}">Stop</button>`
                      : ""
                  }
                  ${
                    item.status === "stopped"
                      ? `<button class="btn btn-inline" data-action="start" data-id="${item.id}">Start</button>`
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
              <td>${escapeHtml(item.name)}</td>
              <td class="mono">${escapeHtml(item.source_instance_id)}</td>
              <td class="mono">${escapeHtml(item.image_ref)}</td>
              <td>${toLocalDate(item.created_at)}</td>
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
        title: `Instance Detail — ${escapeHtml(detail.name)}`,
        bodyHtml: `
          <div class="grid grid-2">
            <div>
              <div class="dim">Status</div>
              <div><span class="status ${statusClass(detail.status)}">${detail.status}</span></div>
              ${detail.status_detail ? `<div class="dim" style="font-size:0.8rem;">${escapeHtml(detail.status_detail)}</div>` : ""}
              ${detail.error_message ? `<div style="font-size:0.8rem;color:var(--error);">${escapeHtml(detail.error_message)}</div>` : ""}
            </div>
            <div>
              <div class="dim">Type</div>
              <div><span class="chip mono">${escapeHtml(detail.instance_type)}</span></div>
            </div>
            <div>
              <div class="dim">IP Address</div>
              <div class="mono">${escapeHtml(detail.ip_address || "-")}</div>
            </div>
            <div>
              <div class="dim">SSH Command</div>
              <div class="mono">${escapeHtml(detail.ssh_command || "-")}</div>
            </div>
            <div>
              <div class="dim">SSH Password</div>
              <div class="mono">${escapeHtml(detail.ssh_password || "-")}</div>
            </div>
            <div>
              <div class="dim">Public Endpoint</div>
              <div class="mono">${escapeHtml(detail.public_endpoint || "-")}</div>
            </div>
            <div>
              <div class="dim">vCPU / RAM</div>
              <div class="mono">${detail.vcpu || "-"} vCPU / ${detail.memory_mb || "-"} MB</div>
            </div>
            <div>
              <div class="dim">Tags</div>
              <div>${renderTags(detail.tags)}</div>
            </div>
          </div>
          <div id="instance-metrics" style="margin-top:12px;">
            <div class="dim"><span class="spinner"></span> Memuat metrics…</div>
          </div>
          <hr style="border-color:var(--line);margin:14px 0;" />
          <div class="grid grid-2">
            <div>
              <label class="field-label">Ubah Network</label>
              <select id="modal-network">${createOptionList(
                netsPayload.networks || [],
                (item) => `${item.name} (${item.cidr || "-"})`,
                (item) => item.id,
                detail.network_id,
              )}</select>
              <button id="modal-apply-network" class="btn btn-inline" style="margin-top:8px;">Apply Network</button>
            </div>
            <div>
              <label class="field-label">Ubah Security Group</label>
              <select id="modal-sg">${createOptionList(
                sgsPayload.security_groups || [],
                (item) => `${item.name}${item.is_default ? " [default]" : ""}`,
                (item) => item.id,
                detail.security_group_id,
              )}</select>
              <button id="modal-apply-sg" class="btn btn-inline" style="margin-top:8px;">Apply Security Group</button>
            </div>
          </div>
          <hr style="border-color:var(--line);margin:14px 0;" />
          <div>
            <label class="field-label">Edit Tags <span class="dim">(key=value, comma separated)</span></label>
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
            <div class="grid grid-2" style="gap:8px;">
              <div>
                <div class="dim" style="font-size:0.75rem;">CPU</div>
                <div class="mono">${cpuPct}%</div>
                <div style="background:var(--panel-2);border-radius:4px;height:6px;margin-top:4px;">
                  <div style="width:${Math.min(cpuPct, 100)}%;height:100%;background:var(--primary);border-radius:4px;transition:width .3s;"></div>
                </div>
              </div>
              <div>
                <div class="dim" style="font-size:0.75rem;">Memory</div>
                <div class="mono">${memUsed} / ${memLimit} MB</div>
                <div style="background:var(--panel-2);border-radius:4px;height:6px;margin-top:4px;">
                  <div style="width:${Math.min(memPct, 100)}%;height:100%;background:${memPct > 80 ? 'var(--warn)' : 'var(--ok)'};border-radius:4px;transition:width .3s;"></div>
                </div>
              </div>
            </div>
          `;
        }).catch(() => {
          metricsBox.innerHTML = `<div class="dim" style="font-size:0.85rem;">Metrics tidak tersedia.</div>`;
        });
      } else {
        metricsBox.innerHTML = `<div class="dim" style="font-size:0.85rem;">Metrics hanya tersedia untuk instance running.</div>`;
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
          msg.textContent = "Security group berhasil diupdate. State preserved.";
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
            <button id="log-refresh" class="btn btn-inline btn-ghost" style="margin-left:8px;">Refresh</button>
          </div>
          <pre id="log-output" class="mono panel" style="min-height:200px;max-height:400px;overflow:auto;font-size:0.8rem;white-space:pre-wrap;"><span class="spinner"></span> Loading logs…</pre>
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
          <label class="field-label">Command</label>
          <input id="exec-command" value="uname -a" />
          <button id="run-exec" class="btn btn-inline" style="margin-top:8px;">Run</button>
          <pre id="exec-output" class="mono panel" style="margin-top:10px;min-height:120px;">-</pre>
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
        const result = await withLoading(createBtn, "Creating...", async () => apis.compute.createInstance(payload));
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
        if (action === "snapshot") {
          const modal = showModal({
            title: "Create Snapshot",
            bodyHtml: `
              <label class="field-label" for="snap-name">Nama snapshot (opsional)</label>
              <input id="snap-name" placeholder="my-snapshot" />
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
