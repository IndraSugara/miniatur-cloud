import { escapeHtml } from "../utils.js";

export const catalogView = {
  id: "catalog",
  title: "Catalog",
  subtitle: "Daftar image OS dan instance type yang tersedia.",
  async mount(root, { apis }) {
    root.innerHTML = `
      <div class="grid grid-2">
        <section class="panel">
          <div class="panel-header">
            <h3>OS Images</h3>
          </div>
          <div id="image-list" class="dim"><span class="spinner"></span> Memuat...</div>
        </section>
        <section class="panel">
          <div class="panel-header">
            <h3>Instance Types</h3>
          </div>
          <div id="type-list" class="dim"><span class="spinner"></span> Memuat...</div>
        </section>
      </div>
    `;

    const [imagesPayload, typesPayload] = await Promise.all([apis.catalog.images(), apis.catalog.types()]);
    const images = imagesPayload.images || [];
    const types = typesPayload.instance_types || {};

    const imageListEl = root.querySelector("#image-list");
    if (images.length === 0) {
      imageListEl.innerHTML = `<div class="empty-state" style="padding:20px 0;"><div class="empty-icon">📦</div><p>Tidak ada image tersedia.</p></div>`;
    } else {
      imageListEl.innerHTML = `<div class="stack-sm">${images.map((item) => {
        const key = typeof item === "string" ? item : item.key;
        const desc = typeof item === "object" && item.description ? item.description : "";
        const icon = key.includes("ubuntu") ? "🐧" : key.includes("alpine") ? "🏔" : key.includes("debian") ? "🌀" : "💿";
        return `
          <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-surface);transition:border-color 0.15s;"
               onmouseenter="this.style.borderColor='var(--glass-hover)'" onmouseleave="this.style.borderColor='var(--border)'">
            <span style="font-size:22px;">${icon}</span>
            <div>
              <div class="mono" style="font-weight:600;">${escapeHtml(key)}</div>
              ${desc ? `<div class="muted" style="font-size:12px;">${escapeHtml(desc)}</div>` : ""}
            </div>
          </div>
        `;
      }).join("")}</div>`;
    }

    const typeListEl = root.querySelector("#type-list");
    const typeEntries = Object.entries(types);
    if (typeEntries.length === 0) {
      typeListEl.innerHTML = `<div class="empty-state" style="padding:20px 0;"><div class="empty-icon">⚡</div><p>Tidak ada instance type.</p></div>`;
    } else {
      typeListEl.innerHTML = `<div class="stack-sm">${typeEntries.map(([name, value]) => {
        return `
          <div style="padding:12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-surface);transition:border-color 0.15s;"
               onmouseenter="this.style.borderColor='var(--glass-hover)'" onmouseleave="this.style.borderColor='var(--border)'">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span class="mono" style="font-weight:700;font-size:14px;">${escapeHtml(name)}</span>
              ${value.gpu ? '<span class="badge badge-purple">GPU</span>' : ""}
            </div>
            <div style="display:flex;gap:16px;margin-top:6px;font-size:13px;">
              <span><strong>${value.vcpu}</strong> <span class="muted">vCPU</span></span>
              <span><strong>${value.memory_mb}</strong> <span class="muted">MB</span></span>
              ${value.gpu ? '<span><strong>128-core</strong> <span class="muted">Maxwell</span></span>' : ""}
            </div>
            ${value.description ? `<div class="muted" style="font-size:12px;margin-top:4px;">${escapeHtml(value.description)}</div>` : ""}
          </div>
        `;
      }).join("")}</div>`;
    }

    return () => {};
  },
};