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
          <div id="image-list" class="dim"><span class="spinner"></span> Memuat…</div>
        </section>
        <section class="panel">
          <h3>Instance Types</h3>
          <div id="type-list" class="dim"><span class="spinner"></span> Memuat…</div>
        </section>
      </div>
    `;

    const [imagesPayload, typesPayload] = await Promise.all([apis.catalog.images(), apis.catalog.types()]);
    const images = imagesPayload.images || [];
    const types = typesPayload.instance_types || {};

    root.querySelector("#image-list").innerHTML =
      images.length === 0
        ? `<p class="dim">Tidak ada image.</p>`
        : `<ul>${images.map((item) => `<li><span class="mono">${escapeHtml(item)}</span></li>`).join("")}</ul>`;

    root.querySelector("#type-list").innerHTML =
      Object.keys(types).length === 0
        ? `<p class="dim">Tidak ada type.</p>`
        : `<ul>${Object.entries(types)
            .map(
              ([name, value]) =>
                `<li><span class="mono">${escapeHtml(name)}</span> - ${value.vcpu} vCPU / ${value.memory_mb} MB</li>`,
            )
            .join("")}</ul>`;

    return () => {};
  },
};
