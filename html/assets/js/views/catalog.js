import { escapeHtml } from "../utils.js";

export const catalogView = {
  id: "catalog",
  title: "Catalog",
  subtitle: "Daftar image OS dan instance type yang tersedia.",
  async mount(root, { apis }) {
    root.innerHTML = `
      <div class="grid grid-2">
        <section class="panel">
          <h3>Images</h3>
          <div id="image-list" class="dim"><span class="spinner"></span> Memuat...</div>
        </section>
        <section class="panel">
          <h3>Instance Types</h3>
          <div id="type-list" class="dim"><span class="spinner"></span> Memuat...</div>
        </section>
      </div>
    `;

    const [imagesPayload, typesPayload] = await Promise.all([apis.catalog.images(), apis.catalog.types()]);
    const images = imagesPayload.images || [];
    const types = typesPayload.instance_types || {};

    root.querySelector("#image-list").innerHTML =
      images.length === 0
        ? `<p class="dim">Tidak ada image.</p>`
        : `<div class="table-wrap"><table>
            <thead><tr><th>Image</th><th>Description</th></tr></thead>
            <tbody>${images.map((item) => {
              const key = typeof item === "string" ? item : item.key;
              const desc = typeof item === "object" && item.description ? item.description : "-";
              return `<tr><td class="mono">${escapeHtml(key)}</td><td>${escapeHtml(desc)}</td></tr>`;
            }).join("")}</tbody>
          </table></div>`;

    root.querySelector("#type-list").innerHTML =
      Object.keys(types).length === 0
        ? `<p class="dim">Tidak ada type.</p>`
        : `<div class="table-wrap"><table>
            <thead><tr><th>Type</th><th>vCPU</th><th>RAM</th><th>GPU</th><th>Description</th></tr></thead>
            <tbody>${Object.entries(types)
              .map(
                ([name, value]) =>
                  `<tr><td class="mono">${escapeHtml(name)}</td><td>${value.vcpu}</td><td>${value.memory_mb} MB</td><td>${value.gpu ? "128-core Maxwell" : "-"}</td><td>${escapeHtml(value.description || "-")}</td></tr>`,
              )
              .join("")}</tbody>
          </table></div>`;

    return () => {};
  },
};