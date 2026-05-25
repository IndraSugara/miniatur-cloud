import { REFRESH_MS } from "../config.js";
import { escapeHtml, statusClass, toLocalDate } from "../utils.js";
import { toast } from "../ui.js";

function errMsg(error) {
  return error instanceof Error ? error.message : String(error);
}

export const networkView = {
  id: "network",
  title: "Network",
  subtitle: "Kelola network, security group, floating IP, dan relasi ke instance.",
  async mount(root, { apis }) {
    root.innerHTML = `
      <section class="panel">
        <h3>Create Network</h3>
        <form id="network-form" class="grid grid-3">
          <div>
            <label class="field-label" for="network-name">Name</label>
            <input id="network-name" required placeholder="team-net" />
          </div>
          <div>
            <label class="field-label" for="network-cidr">CIDR (optional)</label>
            <input id="network-cidr" placeholder="172.30.0.0/16" />
          </div>
          <div>
            <label class="field-label" for="network-gateway">Gateway (optional)</label>
            <input id="network-gateway" placeholder="172.30.0.1" />
          </div>
          <div style="grid-column:1/-1;">
            <button class="btn btn-primary" type="submit">Create Network</button>
          </div>
        </form>
      </section>

      <section class="panel">
        <h3>Networks</h3>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>CIDR</th>
                <th>Gateway</th>
                <th>Default</th>
                <th>Created</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody id="network-body">
              <tr><td colspan="6" class="dim">Loading...</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel">
        <div class="toolbar" style="justify-content:space-between;">
          <h3>Security Groups</h3>
          <form id="sg-create-form" class="toolbar">
            <input id="sg-name" placeholder="web-sg" required />
            <button class="btn btn-inline btn-primary" type="submit">Create SG</button>
          </form>
        </div>
        <div id="sg-list" class="grid"></div>
      </section>

      <section class="panel">
        <div class="toolbar" style="justify-content:space-between;">
          <h3>Floating IP</h3>
          <form id="fip-create-form" class="toolbar">
            <select id="fip-instance">
              <option value="">Allocate only</option>
            </select>
            <button class="btn btn-inline btn-primary" type="submit">Allocate</button>
          </form>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Address</th>
                <th>Status</th>
                <th>Instance</th>
                <th>Created</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody id="fip-body">
              <tr><td colspan="5" class="dim">Loading...</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    `;

    const networkBody = root.querySelector("#network-body");
    const sgList = root.querySelector("#sg-list");
    const fipBody = root.querySelector("#fip-body");
    const fipInstanceSelect = root.querySelector("#fip-instance");

    let networks = [];
    let securityGroups = [];
    let floatingIps = [];
    let instances = [];

    function renderNetworks() {
      if (networks.length === 0) {
        networkBody.innerHTML = `<tr><td colspan="6" class="dim">Belum ada network.</td></tr>`;
        return;
      }
      networkBody.innerHTML = networks
        .map(
          (item) => `
            <tr>
              <td>${escapeHtml(item.name)}</td>
              <td class="mono">${escapeHtml(item.cidr || "-")}</td>
              <td class="mono">${escapeHtml(item.gateway || "-")}</td>
              <td>${item.is_default ? "yes" : "no"}</td>
              <td>${toLocalDate(item.created_at)}</td>
              <td>
                <button class="btn btn-inline btn-danger" data-network-delete="${item.id}" ${
                  item.is_default ? "disabled" : ""
                }>
                  Delete
                </button>
              </td>
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
        .map((item) => {
          const rules = item.rules || [];
          const ruleRows =
            rules.length === 0
              ? `<tr><td colspan="4" class="dim">No rules</td></tr>`
              : rules
                  .map(
                    (rule) => `
                      <tr>
                        <td>${escapeHtml(rule.protocol)}</td>
                        <td>${escapeHtml(rule.port_min)}-${escapeHtml(rule.port_max)}</td>
                        <td>${escapeHtml(rule.cidr)}</td>
                        <td><button class="btn btn-inline btn-danger" data-rule-delete="${item.id}|${rule.id}">Delete</button></td>
                      </tr>
                    `,
                  )
                  .join("");

          return `
            <div class="panel">
              <div class="toolbar" style="justify-content:space-between;">
                <strong>${escapeHtml(item.name)} ${item.is_default ? '<span class="chip">default</span>' : ""}</strong>
                <div class="actions">
                  <button class="btn btn-inline" data-rule-add="${item.id}">Add Rule</button>
                  <button class="btn btn-inline btn-danger" data-sg-delete="${item.id}" ${
                    item.is_default ? "disabled" : ""
                  }>Delete SG</button>
                </div>
              </div>
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Protocol</th>
                      <th>Port Range</th>
                      <th>CIDR</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>${ruleRows}</tbody>
                </table>
              </div>
            </div>
          `;
        })
        .join("");
    }

    function renderFloatingIps() {
      if (floatingIps.length === 0) {
        fipBody.innerHTML = `<tr><td colspan="5" class="dim">Belum ada floating IP.</td></tr>`;
        return;
      }
      fipBody.innerHTML = floatingIps
        .map(
          (item) => `
            <tr>
              <td class="mono">${escapeHtml(item.public_ip)}:${escapeHtml(item.public_port)}</td>
              <td><span class="status ${statusClass(item.status)}">${item.status}</span></td>
              <td class="mono">${escapeHtml(item.instance_id || "-")}</td>
              <td>${toLocalDate(item.created_at)}</td>
              <td>
                <div class="actions">
                  ${
                    item.status === "available"
                      ? `<button class="btn btn-inline" data-fip-attach="${item.id}">Attach</button>`
                      : `<button class="btn btn-inline" data-fip-detach="${item.id}">Detach</button>`
                  }
                  <button class="btn btn-inline btn-danger" data-fip-delete="${item.id}" ${
                    item.status !== "available" ? "disabled" : ""
                  }>Delete</button>
                </div>
              </td>
            </tr>
          `,
        )
        .join("");
    }

    function renderFipInstanceChoices() {
      const rows = instances
        .filter((item) => ["running", "stopped"].includes(String(item.status).toLowerCase()))
        .map((item) => `<option value="${item.id}">${escapeHtml(item.name)} (${escapeHtml(item.status)})</option>`)
        .join("");
      fipInstanceSelect.innerHTML = `<option value="">Allocate only</option>${rows}`;
    }

    async function loadAll() {
      const [netPayload, sgPayload, fipPayload, instancePayload] = await Promise.all([
        apis.network.listNetworks(),
        apis.network.listSecurityGroups(),
        apis.network.listFloatingIps(),
        apis.compute.listInstances(),
      ]);
      networks = netPayload.networks || [];
      securityGroups = sgPayload.security_groups || [];
      floatingIps = fipPayload.floating_ips || [];
      instances = instancePayload.instances || [];
      renderNetworks();
      renderSecurityGroups();
      renderFloatingIps();
      renderFipInstanceChoices();
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

    root.querySelector("#fip-create-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const instanceId = fipInstanceSelect.value || null;
        await apis.network.createFloatingIp(instanceId);
        toast("Floating IP dialokasikan.");
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
        const portMin = Number(window.prompt("port_min", "22"));
        const portMax = Number(window.prompt("port_max", String(portMin)));
        const cidr = window.prompt("cidr", "0.0.0.0/0") || "0.0.0.0/0";
        if (!Number.isFinite(portMin) || !Number.isFinite(portMax)) return;
        try {
          await apis.network.addSecurityGroupRule(addRule, {
            port_min: portMin,
            port_max: portMax,
            cidr,
          });
          toast("Rule ditambahkan.");
          await loadAll();
        } catch (error) {
          toast(errMsg(error), "error");
        }
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

    fipBody.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;

      const deleteId = target.dataset.fipDelete;
      if (deleteId) {
        if (!window.confirm("Delete floating IP ini?")) return;
        try {
          await apis.network.deleteFloatingIp(deleteId);
          toast("Floating IP dihapus.");
          await loadAll();
        } catch (error) {
          toast(errMsg(error), "error");
        }
        return;
      }

      const detachId = target.dataset.fipDetach;
      if (detachId) {
        try {
          await apis.network.detachFloatingIp(detachId);
          toast("Floating IP dilepas.");
          await loadAll();
        } catch (error) {
          toast(errMsg(error), "error");
        }
        return;
      }

      const attachId = target.dataset.fipAttach;
      if (attachId) {
        const choices = instances
          .filter((item) => ["running", "stopped"].includes(String(item.status).toLowerCase()))
          .map((item) => `${item.id}:${escapeHtml(item.name)}`)
          .join("\n");
        const input = window.prompt(`Masukkan instance_id tujuan:\n${choices}`);
        if (!input) return;
        try {
          await apis.network.attachFloatingIp(attachId, input.trim());
          toast("Floating IP terpasang.");
          await loadAll();
        } catch (error) {
          toast(errMsg(error), "error");
        }
      }
    });

    await loadAll();

    const timer = window.setInterval(() => {
      loadAll().catch(() => {
        // ignore periodic refresh failure
      });
    }, REFRESH_MS);

    return () => window.clearInterval(timer);
  },
};
