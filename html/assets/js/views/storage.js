import { REFRESH_MS } from "../config.js";
import { escapeHtml, toLocalDate } from "../utils.js";
import { showModal, toast } from "../ui.js";

function em(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Format bytes to human-readable size. */
function formatSize(bytes) {
  if (bytes == null || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let size = Number(bytes);
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export const storageView = {
  id: "storage",
  title: "Storage",
  subtitle: "Kelola block volume dan object storage (bucket/object).",
  async mount(root, { apis, navigate, state }) {
    const activeWs = state.activeWorkspace;

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
              <tr><td colspan="7" class="dim"><span class="spinner"></span> Memuat...</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel">
        <div class="toolbar" style="justify-content:space-between;margin-bottom:12px;">
          <h3 style="margin:0;">Buckets</h3>
          <form id="bucket-create-form" class="toolbar">
            <input id="bucket-name" placeholder="my-bucket (optional)" style="width:200px;" />
            <button class="btn btn-inline btn-primary" type="submit">Create Bucket</button>
          </form>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Network</th>
                <th>Owner</th>
                <th>Created</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody id="bucket-body">
              <tr><td colspan="5" class="dim"><span class="spinner"></span> Memuat...</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel" id="objects-panel">
        <div class="toolbar" style="justify-content:space-between;margin-bottom:12px;">
          <h3 id="object-title" style="margin:0;">Objects</h3>
          <div class="toolbar">
            <form id="object-filter-form" class="toolbar">
              <input id="object-prefix" placeholder="prefix/" style="width:150px;" />
              <button class="btn btn-inline" type="submit">Filter</button>
            </form>
            <button id="upload-object-btn" class="btn btn-inline btn-primary" disabled>Upload</button>
          </div>
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
    const uploadBtn = root.querySelector("#upload-object-btn");

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

    function resolveNetworkName(networkId) {
      if (!networkId) return '<span class="dim">—</span>';
      // Look up from state networks or cached network list
      const net = (state.networks || []).find((n) => n.id === networkId);
      return net ? escapeHtml(net.name) : '<span class="dim">' + escapeHtml(networkId.slice(0, 8) + '…') + '</span>';
    }

    function renderBuckets() {
      let filtered = buckets;
      if (activeWs) {
        filtered = buckets.filter((b) => b.network_id === activeWs);
      }
      if (filtered.length === 0) {
        bucketBody.innerHTML = `<tr><td colspan="5" class="dim">Belum ada bucket${activeWs ? " di workspace ini" : ""}.</td></tr>`;
        return;
      }
      bucketBody.innerHTML = filtered
        .map(
          (item) => `
            <tr>
              <td class="mono">${escapeHtml(item.name)}</td>
              <td>${resolveNetworkName(item.network_id)}</td>
              <td class="mono" style="font-size:11px;">${escapeHtml(item.owner_id ? item.owner_id.slice(0,8)+'…' : '-')}</td>
              <td>${toLocalDate(item.created_at)}</td>
              <td>
                <div class="actions">
                  <button class="btn btn-inline" data-bucket-open="${item.name}">Browse</button>
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
        uploadBtn.disabled = true;
        return;
      }
      objectTitle.textContent = `Objects — ${activeBucket}`;
      uploadBtn.disabled = false;
      const prefix = objectPrefixInput.value.trim();
      try {
        const payload = await apis.storage.listObjects(activeBucket, prefix, 200);
        const objects = payload.objects || [];
        if (objects.length === 0) {
          objectBody.innerHTML = `<tr><td colspan="4" class="dim">Bucket kosong${prefix ? " (prefix: " + escapeHtml(prefix) + ")" : ""}.</td></tr>`;
          return;
        }
        objectBody.innerHTML = objects
          .map(
            (item) => `
              <tr>
                <td class="mono" style="max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(item.key)}">${escapeHtml(item.key)}</td>
                <td>${formatSize(item.size)}</td>
                <td>${item.last_modified ? toLocalDate(item.last_modified) : "-"}</td>
                <td>
                  <div class="actions">
                    <button class="btn btn-inline" data-obj-dl="${item.key}">Download</button>
                    <button class="btn btn-inline" data-obj-view="${item.key}">View</button>
                    <button class="btn btn-inline btn-danger" data-obj-del="${item.key}">Delete</button>
                  </div>
                </td>
              </tr>
            `,
          )
          .join("");
      } catch (error) {
        objectBody.innerHTML = `<tr><td colspan="4" class="dim">Gagal memuat: ${em(error)}</td></tr>`;
      }
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

    // ── Volume create ──
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

    // ── Volume actions ──
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
        } catch (error) { toast(em(error), "error"); }
        return;
      }

      const attachId = target.dataset.volAttach;
      if (attachId) {
        const eligible = instances.filter((item) => ["running", "stopped"].includes(String(item.status).toLowerCase()));
        if (eligible.length === 0) {
          toast("Tidak ada instance yang bisa dipasang.", "error");
          return;
        }
        const optionsHtml = eligible
          .map((item) => `<option value="${item.id}">${escapeHtml(item.name)} (${item.status})</option>`)
          .join("");
        const modal = showModal({
          title: "Attach Volume",
          bodyHtml: `
            <p class="dim" style="margin-bottom:8px;font-size:0.85rem;">Instance akan restart sebentar. Software terinstall tetap tersimpan.</p>
            <div class="grid grid-2">
              <div>
                <label class="field-label" for="vol-attach-inst">Instance</label>
                <select id="vol-attach-inst">${optionsHtml}</select>
              </div>
              <div>
                <label class="field-label" for="vol-attach-path">Mount Path</label>
                <input id="vol-attach-path" value="/mnt/vol-${attachId}" />
              </div>
            </div>
          `,
          actions: [{
            label: "Attach",
            className: "btn btn-primary",
            onClick: async ({ close }) => {
              const iid = modal.wrapper.querySelector("#vol-attach-inst").value;
              const mp = modal.wrapper.querySelector("#vol-attach-path").value.trim() || undefined;
              try {
                await apis.storage.attachVolume(attachId, { instance_id: iid, mount_path: mp });
                toast("Volume terpasang. Instance restart untuk menerapkan perubahan.");
                close();
                await loadAll();
              } catch (error) { toast(em(error), "error"); }
            },
          }],
        });
        return;
      }

      const detach = target.dataset.volDetach;
      if (detach) {
        const [volumeId, instanceId] = detach.split("|");
        if (!instanceId) { toast("instance_id tidak ditemukan.", "error"); return; }
        try {
          await apis.storage.detachVolume(volumeId, { instance_id: instanceId });
          toast("Volume dilepas. Instance restart untuk menerapkan perubahan.");
          await loadAll();
        } catch (error) { toast(em(error), "error"); }
      }
    });

    // ── Bucket create ──
    root.querySelector("#bucket-create-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = root.querySelector("#bucket-name").value.trim();
      try {
        const netId = activeWs || null;
        await apis.storage.createBucket(name || null, netId);
        toast(netId ? "Bucket dibuat dalam workspace." : "Bucket dibuat.");
        event.target.reset();
        await loadAll();
      } catch (error) { toast(em(error), "error"); }
    });

    // ── Bucket actions ──
    bucketBody.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;

      const openName = target.dataset.bucketOpen;
      if (openName) {
        activeBucket = openName;
        objectPrefixInput.value = "";
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
        } catch (error) { toast(em(error), "error"); }
      }
    });

    // ── Object filter ──
    root.querySelector("#object-filter-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      await loadObjects().catch((error) => toast(em(error), "error"));
    });

    // ── Upload object ──
    uploadBtn.addEventListener("click", async () => {
      if (!activeBucket) return;
      const modal = showModal({
        title: `Upload to ${activeBucket}`,
        bodyHtml: `
          <div class="upload-zone" id="upload-drop-zone">
            <div class="icon">📁</div>
            <p>Klik atau drag file ke sini</p>
            <input type="file" id="upload-file-input" style="display:none;" />
            <p class="dim" style="font-size:12px;margin-top:8px;">File akan di-upload via presigned URL</p>
          </div>
          <div id="upload-status" class="dim" style="margin-top:10px;text-align:center;"></div>
        `,
      });

      const dropZone = modal.wrapper.querySelector("#upload-drop-zone");
      const fileInput = modal.wrapper.querySelector("#upload-file-input");
      const statusEl = modal.wrapper.querySelector("#upload-status");

      dropZone.addEventListener("click", () => fileInput.click());
      dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); });
      dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
      dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.remove("drag-over");
        const file = e.dataTransfer.files[0];
        if (file) uploadFile(file);
      });
      fileInput.addEventListener("change", () => {
        const file = fileInput.files[0];
        if (file) uploadFile(file);
      });

      async function uploadFile(file) {
        statusEl.textContent = `Uploading ${file.name} (${formatSize(file.size)})...`;
        statusEl.className = "";
        try {
          // Get presigned URL
          const presigned = await apis.storage.presignUpload(activeBucket, {
            object_key: file.name,
            expiry_seconds: 3600,
          });

          // Upload via presigned PUT
          const uploadRes = await fetch(presigned.url, {
            method: "PUT",
            body: file,
            headers: { "Content-Type": file.type || "application/octet-stream" },
          });

          if (!uploadRes.ok) {
            throw new Error(`Upload failed: HTTP ${uploadRes.status}`);
          }

          statusEl.textContent = `✅ ${file.name} berhasil diupload!`;
          statusEl.className = "message ok";
          modal.close();
          await loadObjects();
        } catch (error) {
          statusEl.textContent = `❌ ${em(error)}`;
          statusEl.className = "message error";
        }
      }
    });

    // ── Object actions ──
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
        } catch (error) { toast(em(error), "error"); }
        return;
      }

      const viewKey = target.dataset.objView;
      if (viewKey) {
        try {
          const presigned = await apis.storage.presignDownload(activeBucket, {
            object_key: viewKey,
            expiry_seconds: 300,
          });
          // Try to fetch and preview
          const res = await fetch(presigned.url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const contentType = res.headers.get("content-type") || "";
          const isText = contentType.includes("text") || contentType.includes("json") || contentType.includes("xml") || contentType.includes("javascript");
          const text = await res.text();

          showModal({
            title: `Preview: ${viewKey}`,
            bodyHtml: isText
              ? `<div class="object-preview">${escapeHtml(text.slice(0, 50000))}${text.length > 50000 ? "\n\n... (truncated)" : ""}</div>`
              : `<p class="dim">Binary file (${contentType || "unknown type"}) — tidak bisa dipreview.</p>
                 <a href="${presigned.url}" target="_blank" class="btn btn-inline" style="margin-top:8px;">Download langsung</a>`,
          });
        } catch (error) {
          toast(`Gagal preview: ${em(error)}`, "error");
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
          // Open download in new tab
          window.open(presigned.url, "_blank", "noopener");
          toast("Download dimulai di tab baru.");
        } catch (error) { toast(em(error), "error"); }
      }
    });

    await loadAll();
    const timer = window.setInterval(() => {
      loadAll().catch(() => {});
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  },
};
