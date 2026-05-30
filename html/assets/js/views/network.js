import { REFRESH_MS } from "../config.js";
import { escapeHtml, statusClass } from "../utils.js";
import { showModal, toast } from "../ui.js";

function errMsg(error) {
  return error instanceof Error ? error.message : String(error);
}

export const networkView = {
  id: "network",
  title: "Network",
  subtitle: "Kelola network, security group, dan public endpoint.",
  async mount(root, { apis }) {
    root.innerHTML = `
      <section class="panel">
        <h3>Create Network</h3>
        <form id="network-form" class="grid grid-3">
          <div>
            <label class="field-label" for="network-name">Name</label>
            <input id="network-name" required placeholder="my-net" />
          </div>
          <div>
            <label class="field-label" for="network-cidr">CIDR (optional)</label>
            <input id="network-cidr" placeholder="10.10.0.0/24" />
          </div>
          <div>
            <label class="field-label" for="network-gateway">Gateway (optional)</label>
            <input id="network-gateway" placeholder="10.10.0.1" />
          </div>
          <div style="grid-column:1/-1;" class="toolbar">
            <button class="btn btn-primary" type="submit">Create Network</button>
          </div>
        </form>
      </section>

      <section class="panel">
        <h3>Networks</h3>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>CIDR</th><th>Gateway</th><th>Default</th><th>Action</th></tr>
            </thead>
            <tbody id="network-body">
              <tr><td colspan="5" class="dim"><span class="spinner"></span> Memuat...</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel">
        <h3>Security Groups</h3>
        <form id="sg-create-form" class="toolbar" style="margin-bottom:12px;">
          <input id="sg-name" placeholder="Nama SG baru" required />
          <button class="btn btn-primary" type="submit">Create</button>
        </form>
        <div id="sg-list"></div>
      </section>

      <section class="panel">
        <h3>Public Endpoints</h3>
        <p class="dim" style="margin-bottom:8px;font-size:0.85rem;">
          Port forwards from host IP to container SSH port.
        </p>
        <form id="ep-create-form" class="toolbar" style="margin-bottom:12px;">
          <select id="ep-instance-select">
            <option value="">Allocate only</option>
          </select>
          <button class="btn btn-primary" type="submit">Allocate Endpoint</button>
        </form>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Public IP</th><th>Port</th><th>Instance</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody id="ep-body">
              <tr><td colspan="5" class="dim"><span class="spinner"></span> Memuat...</td></tr>
            </tbody>
          </table>
        </div>
      </section>
      <section class="panel">
        <h3>Ingress Routes</h3>
        <p class="dim" style="margin-bottom:8px;font-size:0.85rem;">
          Dynamic HTTP proxy routing via Nginx.
        </p>
        <div class="toolbar" style="margin-bottom:12px;">
          <button id="btn-create-ingress" class="btn btn-primary">Create Ingress</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Path</th><th>Target Port</th><th>Instance</th><th>Actions</th></tr>
            </thead>
            <tbody id="ingress-body">
              <tr><td colspan="4" class="dim"><span class="spinner"></span> Memuat...</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    `;

    const networkBody = root.querySelector("#network-body");
    const sgList = root.querySelector("#sg-list");
    const epBody = root.querySelector("#ep-body");
    const epInstanceSelect = root.querySelector("#ep-instance-select");
    const ingressBody = root.querySelector("#ingress-body");
    const btnCreateIngress = root.querySelector("#btn-create-ingress");

    let networks = [];
    let securityGroups = [];
    let publicEndpoints = [];
    let ingressRules = [];
    let instances = [];

    function renderNetworks() {
      if (networks.length === 0) {
        networkBody.innerHTML = `<tr><td colspan="5" class="dim">Belum ada network.</td></tr>`;
        return;
      }
      networkBody.innerHTML = networks
        .map(
          (n) => `
            <tr>
              <td>${escapeHtml(n.name)}</td>
              <td class="mono">${escapeHtml(n.cidr || "-")}</td>
              <td class="mono">${escapeHtml(n.gateway || "-")}</td>
              <td>${n.is_default ? "Yes" : ""}</td>
              <td>${
                n.is_default
                  ? '<span class="dim">-</span>'
                  : `<button class="btn btn-inline btn-danger" data-network-delete="${n.id}">Delete</button>`
              }</td>
            </tr>
          `,
        )
        .join("");
    }

    function renderSecurityGroups() {
      if (securityGroups.length === 0) {
        sgList.innerHTML = `<div class="dim">Belum ada security group.</div>`;
        return;
      }
      sgList.innerHTML = securityGroups
        .map((sg) => {
          const rules = (sg.rules || [])
            .map(
              (r) => `
                <tr>
                  <td>${escapeHtml(r.direction)}</td>
                  <td>${escapeHtml(r.protocol)}</td>
                  <td class="mono">${r.port_min}-${r.port_max}</td>
                  <td class="mono">${escapeHtml(r.cidr)}</td>
                  <td>
                    ${sg.is_default ? "" : `<button class="btn btn-inline btn-danger" data-rule-delete="${sg.id}|${r.id}" style="font-size:0.75rem;">x</button>`}
                  </td>
                </tr>
              `,
            )
            .join("");
          return `
            <div class="panel" style="margin-bottom:8px;padding:10px;">
              <div class="toolbar" style="justify-content:space-between;">
                <strong>${escapeHtml(sg.name)}${sg.is_default ? " [default]" : ""}</strong>
                <div class="actions">
                  <button class="btn btn-inline" data-rule-add="${sg.id}">Add Rule</button>
                  ${sg.is_default ? "" : `<button class="btn btn-inline btn-danger" data-sg-delete="${sg.id}">Delete</button>`}
                </div>
              </div>
              ${
                rules
                  ? `<table style="margin-top:8px;"><thead><tr><th>Dir</th><th>Proto</th><th>Ports</th><th>CIDR</th><th></th></tr></thead><tbody>${rules}</tbody></table>`
                  : '<div class="dim" style="margin-top:8px;">No rules</div>'
              }
            </div>
          `;
        })
        .join("");
    }

    function resolveInstanceName(instanceId) {
      if (!instanceId) return "-";
      const inst = instances.find((i) => i.id === instanceId);
      return inst ? inst.name : instanceId.slice(0, 8) + "...";
    }

    function renderPublicEndpoints() {
      if (publicEndpoints.length === 0) {
        epBody.innerHTML = `<tr><td colspan="5" class="dim">Belum ada public endpoint.</td></tr>`;
        return;
      }
      epBody.innerHTML = publicEndpoints
        .map(
          (ep) => `
            <tr>
              <td class="mono">${escapeHtml(ep.public_ip)}</td>
              <td class="mono">${ep.public_port}</td>
              <td>${escapeHtml(resolveInstanceName(ep.instance_id))}</td>
              <td><span class="status ${statusClass(ep.status)}">${ep.status}</span></td>
              <td>
                <div class="actions">
                  ${
                    ep.status === "available"
                      ? `<button class="btn btn-inline" data-ep-attach="${ep.id}">Attach</button>`
                      : ""
                  }
                  ${
                    ep.instance_id
                      ? `<button class="btn btn-inline" data-ep-detach="${ep.id}">Detach</button>`
                      : ""
                  }
                  ${
                    ep.status === "available"
                      ? `<button class="btn btn-inline btn-danger" data-ep-delete="${ep.id}">Delete</button>`
                      : ""
                  }
                </div>
              </td>
            </tr>
          `,
        )
        .join("");
    }

    function renderEpInstanceChoices() {
      const rows = instances
        .filter((item) => ["running", "stopped"].includes(String(item.status).toLowerCase()))
        .map((item) => `<option value="${item.id}">${escapeHtml(item.name)} (${escapeHtml(item.status)})</option>`)
        .join("");
      epInstanceSelect.innerHTML = `<option value="">Allocate only</option>${rows}`;
    }

    function renderIngressRules() {
      if (ingressRules.length === 0) {
        ingressBody.innerHTML = `<tr><td colspan="4" class="dim">Belum ada ingress rule.</td></tr>`;
        return;
      }
      ingressBody.innerHTML = ingressRules
        .map(
          (r) => `
            <tr>
              <td class="mono"><a href="${escapeHtml(r.path)}" target="_blank">${escapeHtml(r.path)}</a></td>
              <td class="mono">${r.target_port}</td>
              <td>${escapeHtml(resolveInstanceName(r.instance_id))}</td>
              <td>
                <button class="btn btn-inline btn-danger" data-ingress-delete="${r.id}">Delete</button>
              </td>
            </tr>
          `,
        )
        .join("");
    }

    async function loadAll() {
      const [netPayload, sgPayload, epPayload, inPayload, instancePayload] = await Promise.all([
        apis.network.listNetworks(),
        apis.network.listSecurityGroups(),
        apis.network.listPublicEndpoints(),
        apis.network.listIngressRules(),
        apis.compute.listInstances(),
      ]);
      networks = netPayload.networks || [];
      securityGroups = sgPayload.security_groups || [];
      publicEndpoints = epPayload.public_endpoints || [];
      ingressRules = inPayload.ingress_rules || [];
      instances = instancePayload.instances || [];
      renderNetworks();
      renderSecurityGroups();
      renderPublicEndpoints();
      renderEpInstanceChoices();
      renderIngressRules();
    }

    root.querySelector("#network-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = {
        name: root.querySelector("#network-name").value.trim(),
      };
      const cidr = root.querySelector("#network-cidr").value.trim();
      const gateway = root.querySelector("#network-gateway").value.trim();
      if (cidr) payload.cidr = cidr;
      if (gateway) payload.gateway = gateway;
      try {
        await apis.network.createNetwork(payload);
        toast("Network berhasil dibuat.");
        event.target.reset();
        await loadAll();
      } catch (error) {
        toast(errMsg(error), "error");
      }
    });

    root.querySelector("#sg-create-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = root.querySelector("#sg-name").value.trim();
      if (!name) return;
      try {
        await apis.network.createSecurityGroup(name);
        toast("Security group dibuat.");
        event.target.reset();
        await loadAll();
      } catch (error) {
        toast(errMsg(error), "error");
      }
    });

    root.querySelector("#ep-create-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const instanceId = epInstanceSelect.value || null;
        await apis.network.createPublicEndpoint(instanceId);
        toast("Public endpoint dialokasikan.");
        await loadAll();
      } catch (error) {
        toast(errMsg(error), "error");
      }
    });

    networkBody.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const id = target.dataset.networkDelete;
      if (!id) return;
      if (!window.confirm("Hapus network ini?")) return;
      try {
        await apis.network.deleteNetwork(id);
        toast("Network dihapus.");
        await loadAll();
      } catch (error) {
        toast(errMsg(error), "error");
      }
    });

    sgList.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;

      const deleteSg = target.dataset.sgDelete;
      if (deleteSg) {
        if (!window.confirm("Hapus security group ini?")) return;
        try {
          await apis.network.deleteSecurityGroup(deleteSg);
          toast("Security group dihapus.");
          await loadAll();
        } catch (error) {
          toast(errMsg(error), "error");
        }
        return;
      }

      const addRule = target.dataset.ruleAdd;
      if (addRule) {
        const modal = showModal({
          title: "Add Security Group Rule",
          bodyHtml: `
            <div class="grid grid-3">
              <div>
                <label class="field-label" for="rule-port-min">Port Min</label>
                <input id="rule-port-min" type="number" value="22" min="1" max="65535" />
              </div>
              <div>
                <label class="field-label" for="rule-port-max">Port Max</label>
                <input id="rule-port-max" type="number" value="22" min="1" max="65535" />
              </div>
              <div>
                <label class="field-label" for="rule-cidr">CIDR</label>
                <input id="rule-cidr" value="0.0.0.0/0" />
              </div>
            </div>
          `,
          actions: [
            {
              label: "Add Rule",
              className: "btn btn-primary",
              onClick: async ({ close }) => {
                const portMin = Number(modal.wrapper.querySelector("#rule-port-min").value);
                const portMax = Number(modal.wrapper.querySelector("#rule-port-max").value);
                const cidr = modal.wrapper.querySelector("#rule-cidr").value || "0.0.0.0/0";
                if (!Number.isFinite(portMin) || !Number.isFinite(portMax)) {
                  toast("Port harus angka.", "error");
                  return;
                }
                try {
                  await apis.network.addSecurityGroupRule(addRule, { port_min: portMin, port_max: portMax, cidr });
                  toast("Rule ditambahkan.");
                  close();
                  await loadAll();
                } catch (error) {
                  toast(errMsg(error), "error");
                }
              },
            },
          ],
        });
        return;
      }

      const deleteRule = target.dataset.ruleDelete;
      if (deleteRule) {
        const [sgId, ruleId] = deleteRule.split("|");
        if (!window.confirm("Hapus rule ini?")) return;
        try {
          await apis.network.deleteSecurityGroupRule(sgId, ruleId);
          toast("Rule dihapus.");
          await loadAll();
        } catch (error) {
          toast(errMsg(error), "error");
        }
      }
    });

    epBody.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;

      const deleteId = target.dataset.epDelete;
      if (deleteId) {
        if (!window.confirm("Delete public endpoint ini?")) return;
        try {
          await apis.network.deletePublicEndpoint(deleteId);
          toast("Public endpoint dihapus.");
          await loadAll();
        } catch (error) {
          toast(errMsg(error), "error");
        }
        return;
      }

      const detachId = target.dataset.epDetach;
      if (detachId) {
        try {
          await apis.network.detachPublicEndpoint(detachId);
          toast("Public endpoint dilepas.");
          await loadAll();
        } catch (error) {
          toast(errMsg(error), "error");
        }
        return;
      }

      const attachId = target.dataset.epAttach;
      if (attachId) {
        const choices = instances
          .filter((item) => ["running", "stopped"].includes(String(item.status).toLowerCase()));
        if (choices.length === 0) {
          toast("Tidak ada instance yang bisa dipasang.", "error");
          return;
        }
        const optionsHtml = choices
          .map((item) => `<option value="${item.id}">${escapeHtml(item.name)} (${item.status})</option>`)
          .join("");
        const modal = showModal({
          title: "Attach Public Endpoint",
          bodyHtml: `
            <label class="field-label" for="ep-target">Pilih Instance</label>
            <select id="ep-target">${optionsHtml}</select>
          `,
          actions: [
            {
              label: "Attach",
              className: "btn btn-primary",
              onClick: async ({ close }) => {
                const instanceId = modal.wrapper.querySelector("#ep-target").value;
                try {
                  await apis.network.attachPublicEndpoint(attachId, instanceId);
                  toast("Public endpoint terpasang.");
                  close();
                  await loadAll();
                } catch (error) {
                  toast(errMsg(error), "error");
                }
              },
            },
          ],
        });
      }
    });

    btnCreateIngress.addEventListener("click", () => {
      const choices = instances
        .filter((item) => ["running", "stopped"].includes(String(item.status).toLowerCase()));
      if (choices.length === 0) {
        toast("Tidak ada instance yang bisa dipilih.", "error");
        return;
      }
      const optionsHtml = choices
        .map((item) => `<option value="${item.id}">${escapeHtml(item.name)} (${item.status})</option>`)
        .join("");
      
      const modal = showModal({
        title: "Create Ingress Route",
        bodyHtml: `
          <div class="grid grid-1" style="gap:10px;">
            <div>
              <label class="field-label" for="in-target">Pilih Instance</label>
              <select id="in-target">${optionsHtml}</select>
            </div>
            <div>
              <label class="field-label" for="in-path">Path (e.g. /my-api/)</label>
              <input id="in-path" type="text" placeholder="/my-api/" required />
            </div>
            <div>
              <label class="field-label" for="in-port">Target Port</label>
              <input id="in-port" type="number" value="8000" min="1" max="65535" required />
            </div>
          </div>
        `,
        actions: [
          {
            label: "Create",
            className: "btn btn-primary",
            onClick: async ({ close }) => {
              const instanceId = modal.wrapper.querySelector("#in-target").value;
              const path = modal.wrapper.querySelector("#in-path").value;
              const targetPort = Number(modal.wrapper.querySelector("#in-port").value);
              
              if (!path) {
                toast("Path wajib diisi.", "error");
                return;
              }
              
              try {
                await apis.network.createIngressRule({
                  instance_id: instanceId,
                  path: path,
                  target_port: targetPort
                });
                toast("Ingress rule dibuat.");
                close();
                await loadAll();
              } catch (error) {
                toast(errMsg(error), "error");
              }
            },
          },
        ],
      });
    });

    ingressBody.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;

      const deleteId = target.dataset.ingressDelete;
      if (deleteId) {
        if (!window.confirm("Delete ingress route ini?")) return;
        try {
          await apis.network.deleteIngressRule(deleteId);
          toast("Ingress route dihapus.");
          await loadAll();
        } catch (error) {
          toast(errMsg(error), "error");
        }
      }
    });

    await loadAll();

    const timer = window.setInterval(() => {
      loadAll().catch(() => {});
    }, REFRESH_MS);

    return () => window.clearInterval(timer);
  },
};