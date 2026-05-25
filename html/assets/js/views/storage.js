import { REFRESH_MS } from "../config.js";
import { escapeHtml, toLocalDate } from "../utils.js";
import { toast } from "../ui.js";

function em(error) {
  return error instanceof Error ? error.message : String(error);
}

export const storageView = {
  id: "storage",
  title: "Storage",
  subtitle: "Kelola block volume dan object storage (bucket/object).",
  async mount(root, { apis }) {
    root.innerHTML = `
      <section class="panel">
        <h3>Create Volume</h3>
        <form id="volume-create-form" class="toolbar">
          <input id="vol-name" placeholder="data-volume" required />
          <input id="vol-size" type="number" min="1" max="20" value="2" required />
          <button class="btn btn-inline btn-primary" type="submit">Create Volume</button>
        </form>
      </section>

      <section class="panel">
        <h3>Volumes</h3>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Size</th>
                <th>Status</th>
                <th>Attached To</th>
                <th>Mount Path</th>
                <th>Created</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody id="volume-body">
              <tr><td colspan="7" class="dim">Loading...</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel">
        <div class="toolbar" style="justify-content:space-between;">
          <h3>Buckets</h3>
          <form id="bucket-create-form" class="toolbar">
            <input id="bucket-name" placeholder="my-bucket (optional)" />
            <button class="btn btn-inline btn-primary" type="submit">Create Bucket</button>
          </form>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Owner</th>
                <th>Created</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody id="bucket-body">
              <tr><td colspan="4" class="dim">Loading...</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel">
        <div class="toolbar" style="justify-content:space-between;">
          <h3 id="object-title">Objects</h3>
          <form id="object-filter-form" class="toolbar">
            <input id="object-prefix" placeholder="prefix/" />
            <button class="btn btn-inline" type="submit">Load Objects</button>
          </form>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Size</th>
                <th>Updated</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody id="object-body">
              <tr><td colspan="4" class="dim">Pilih bucket dulu.</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    `;

    const volumeBody = root.querySelector("#volume-body");
    const bucketBody = root.querySelector("#bucket-body");
    const objectBody = root.querySelector("#object-body");
    const objectTitle = root.querySelector("#object-title");
    const objectPrefixInput = root.querySelector("#object-prefix");

    let volumes = [];
    let buckets = [];
    let instances = [];
    let activeBucket = null;

    function renderVolumes() {
      if (volumes.length === 0) {
        volumeBody.innerHTML = `<tr><td colspan="7" class="dim">Belum ada volume.</td></tr>`;
        return;
      }
      volumeBody.innerHTML = volumes
        .map(
          (item) => `
            <tr>
              <td>${escapeHtml(item.name)}</td>
              <td>${item.size_gb} GB</td>
              <td>${item.status}</td>
              <td class="mono">${escapeHtml(item.attached_instance_id || "-")}</td>
              <td class="mono">${escapeHtml(item.mount_path || "-")}</td>
              <td>${toLocalDate(item.created_at)}</td>
              <td>
                <div class="actions">
                  ${
                    item.status === "available"
                      ? `<button class="btn btn-inline" data-vol-attach="${item.id}">Attach</button>`
                      : `<button class="btn btn-inline" data-vol-detach="${item.id}|${item.attached_instance_id || ""}">Detach</button>`
                  }
                  <button class="btn btn-inline btn-danger" data-vol-delete="${item.id}" ${
                    item.status !== "available" ? "disabled" : ""
                  }>Delete</button>
                </div>
              </td>
            </tr>
          `,
        )
        .join("");
    }

    function renderBuckets() {
      if (buckets.length === 0) {
        bucketBody.innerHTML = `<tr><td colspan="4" class="dim">Belum ada bucket.</td></tr>`;
        return;
      }
      bucketBody.innerHTML = buckets
        .map(
          (item) => `
            <tr>
              <td class="mono">${escapeHtml(item.name)}</td>
              <td class="mono">${escapeHtml(item.owner_id)}</td>
              <td>${toLocalDate(item.created_at)}</td>
              <td>
                <div class="actions">
                  <button class="btn btn-inline" data-bucket-open="${item.name}">Open</button>
                  <button class="btn btn-inline btn-danger" data-bucket-delete="${item.name}">Delete</button>
                </div>
              </td>
            </tr>
          `,
        )
        .join("");
    }

    async function loadObjects() {
      if (!activeBucket) {
        objectTitle.textContent = "Objects";
        objectBody.innerHTML = `<tr><td colspan="4" class="dim">Pilih bucket dulu.</td></tr>`;
        return;
      }
      objectTitle.textContent = `Objects - ${activeBucket}`;
      const prefix = objectPrefixInput.value.trim();
      const payload = await apis.storage.listObjects(activeBucket, prefix, 200);
      const objects = payload.objects || [];
      if (objects.length === 0) {
        objectBody.innerHTML = `<tr><td colspan="4" class="dim">Object kosong.</td></tr>`;
        return;
      }
      objectBody.innerHTML = objects
        .map(
          (item) => `
            <tr>
              <td class="mono">${escapeHtml(item.key)}</td>
              <td>${item.size}</td>
              <td>${item.last_modified ? toLocalDate(item.last_modified) : "-"}</td>
              <td>
                <div class="actions">
                  <button class="btn btn-inline" data-obj-dl="${item.key}">Presign Download</button>
                  <button class="btn btn-inline btn-danger" data-obj-del="${item.key}">Delete</button>
                </div>
              </td>
            </tr>
          `,
        )
        .join("");
    }

    async function loadAll() {
      const [volumePayload, bucketPayload, instancePayload] = await Promise.all([
        apis.storage.listVolumes(),
        apis.storage.listBuckets(),
        apis.compute.listInstances(),
      ]);
      volumes = volumePayload.volumes || [];
      buckets = bucketPayload.buckets || [];
      instances = instancePayload.instances || [];
      renderVolumes();
      renderBuckets();
      await loadObjects();
    }

    root.querySelector("#volume-create-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = {
        name: root.querySelector("#vol-name").value.trim(),
        size_gb: Number(root.querySelector("#vol-size").value),
      };
      if (!payload.name) return;
      try {
        await apis.storage.createVolume(payload);
        toast("Volume dibuat.");
        event.target.reset();
        root.querySelector("#vol-size").value = "2";
        await loadAll();
      } catch (error) {
        toast(em(error), "error");
      }
    });

    volumeBody.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;

      const deleteId = target.dataset.volDelete;
      if (deleteId) {
        if (!window.confirm("Delete volume ini?")) return;
        try {
          await apis.storage.deleteVolume(deleteId);
          toast("Volume dihapus.");
          await loadAll();
        } catch (error) {
          toast(em(error), "error");
        }
        return;
      }

      const attachId = target.dataset.volAttach;
      if (attachId) {
        const options = instances
          .filter((item) => ["running", "stopped"].includes(String(item.status).toLowerCase()))
          .map((item) => `${item.id}:${item.name}`)
          .join("\n");
        const instanceId = window.prompt(`Masukkan instance_id target:\n${options}`);
        if (!instanceId) return;
        const mountPath = window.prompt("Mount path (opsional)", `/mnt/vol-${attachId}`) || undefined;
        try {
          await apis.storage.attachVolume(attachId, { instance_id: instanceId.trim(), mount_path: mountPath });
          toast("Volume terpasang.");
          await loadAll();
        } catch (error) {
          toast(em(error), "error");
        }
        return;
      }

      const detach = target.dataset.volDetach;
      if (detach) {
        const [volumeId, instanceId] = detach.split("|");
        if (!instanceId) {
          toast("instance_id attachment tidak ditemukan.", "error");
          return;
        }
        try {
          await apis.storage.detachVolume(volumeId, { instance_id: instanceId });
          toast("Volume dilepas.");
          await loadAll();
        } catch (error) {
          toast(em(error), "error");
        }
      }
    });

    root.querySelector("#bucket-create-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = root.querySelector("#bucket-name").value.trim();
      try {
        await apis.storage.createBucket(name || null);
        toast("Bucket dibuat.");
        event.target.reset();
        await loadAll();
      } catch (error) {
        toast(em(error), "error");
      }
    });

    bucketBody.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;

      const openName = target.dataset.bucketOpen;
      if (openName) {
        activeBucket = openName;
        await loadObjects().catch((error) => toast(em(error), "error"));
        return;
      }

      const deleteName = target.dataset.bucketDelete;
      if (deleteName) {
        const force = window.confirm("Hapus bucket beserta seluruh object? Klik Cancel untuk hapus hanya jika kosong.");
        try {
          await apis.storage.deleteBucket(deleteName, force);
          if (activeBucket === deleteName) activeBucket = null;
          toast("Bucket dihapus.");
          await loadAll();
        } catch (error) {
          toast(em(error), "error");
        }
      }
    });

    root.querySelector("#object-filter-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      await loadObjects().catch((error) => toast(em(error), "error"));
    });

    objectBody.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (!activeBucket) return;

      const deleteKey = target.dataset.objDel;
      if (deleteKey) {
        if (!window.confirm("Delete object ini?")) return;
        try {
          await apis.storage.deleteObject(activeBucket, deleteKey);
          toast("Object dihapus.");
          await loadObjects();
        } catch (error) {
          toast(em(error), "error");
        }
        return;
      }

      const downloadKey = target.dataset.objDl;
      if (downloadKey) {
        try {
          const presigned = await apis.storage.presignDownload(activeBucket, {
            object_key: downloadKey,
            expiry_seconds: 3600,
          });
          window.prompt("Copy presigned URL:", presigned.url);
        } catch (error) {
          toast(em(error), "error");
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
