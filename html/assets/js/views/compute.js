import { REFRESH_MS } from "../config.js";
import { createOptionList, escapeHtml, statusClass, toLocalDate, withLoading } from "../utils.js";
import { showModal, toast } from "../ui.js";

function extractMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export const computeView = {
  id: "compute",
  title: "Compute",
  subtitle: "Kelola instance, tindakan lifecycle, SSH, exec, dan snapshot.",
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
            <label class="field-label" for="inst-fip">Floating IP (optional)</label>
            <select id="inst-fip">
              <option value="">Auto SSH Port</option>
            </select>
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
                <th>SSH/FIP</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="instance-body">
              <tr><td colspan="8" class="dim">Loading...</td></tr>
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
              <tr><td colspan="5" class="dim">Loading...</td></tr>
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
    const fipSelect = root.querySelector("#inst-fip");

    let instances = [];
    let networkList = [];
    let securityGroups = [];
    let floatingIps = [];

    async function loadCreateDependencies() {
      const [imagesPayload, typesPayload, netsPayload, sgsPayload, fipsPayload] = await Promise.all([
        apis.catalog.images(),
        apis.catalog.types(),
        apis.network.listNetworks(),
        apis.network.listSecurityGroups(),
        apis.network.listFloatingIps(),
      ]);
      const images = imagesPayload.images || [];
      const types = typesPayload.instance_types || {};
      networkList = netsPayload.networks || [];
      securityGroups = sgsPayload.security_groups || [];
      floatingIps = fipsPayload.floating_ips || [];

      imageSelect.innerHTML = images
        .map((img) => `<option value="${img}">${img}</option>`)
        .join("");

      typeSelect.innerHTML = Object.entries(types)
        .map(
          ([key, value]) =>
            `<option value="${key}">${key} (${value.vcpu} vCPU / ${value.memory_mb} MB)</option>`,
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
      fipSelect.innerHTML = `<option value="">Auto SSH Port</option>${createOptionList(
        floatingIps.filter((ip) => ip.status === "available"),
        (item) => `${item.public_ip}:${item.public_port}`,
        (item) => item.id,
      )}`;
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
              <td><span class="status ${statusClass(item.status)}">${item.status}</span></td>
              <td>${escapeHtml(item.image)}</td>
              <td><span class="chip mono">${escapeHtml(item.instance_type)}</span></td>
              <td class="mono">${escapeHtml(item.network_id || "-")}</td>
              <td class="mono">${escapeHtml(item.floating_ip || (item.ssh_port ? "port " + item.ssh_port : "-"))}</td>
              <td>${toLocalDate(item.created_at)}</td>
              <td>
                <div class="actions">
                  <button class="btn btn-inline" data-action="detail" data-id="${item.id}">Detail</button>
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
        title: `Instance Detail - ${escapeHtml(detail.name)}`,
        bodyHtml: `
          <div class="grid grid-2">
            <div>
              <div class="dim">Status</div>
              <div><span class="status ${statusClass(detail.status)}">${detail.status}</span></div>
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
              <div class="dim">Floating IP</div>
              <div class="mono">${escapeHtml(detail.floating_ip || "-")}</div>
            </div>
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
          <p id="modal-detail-message" class="message hidden" style="margin-top:10px;"></p>
        `,
      });

      const modalRoot = modal.wrapper;
      const msg = modalRoot.querySelector("#modal-detail-message");
      const applyNetworkBtn = modalRoot.querySelector("#modal-apply-network");
      const applySgBtn = modalRoot.querySelector("#modal-apply-sg");

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
    }

    async function openExecModal(instanceId) {
      const modal = showModal({
        title: `Exec Command - ${instanceId.slice(0, 8)}`,
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
      if (fipSelect.value) payload.floating_ip_id = fipSelect.value;

      if (!payload.name) {
        messageEl.className = "message error";
        messageEl.textContent = "Nama instance wajib diisi.";
        return;
      }

      try {
        await withLoading(createBtn, "Creating...", async () => apis.compute.createInstance(payload));
        messageEl.className = "message ok";
        messageEl.textContent = "Permintaan create instance berhasil dikirim.";
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
        if (action === "exec") {
          await openExecModal(id);
          return;
        }
        if (action === "snapshot") {
          const name = window.prompt("Nama snapshot (opsional):", "");
          await apis.compute.createSnapshot(id, name || null);
          toast("Snapshot berhasil dibuat.");
          await renderSnapshots();
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
