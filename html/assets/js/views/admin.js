import { escapeHtml, toLocalDate } from "../utils.js";
import { showModal, toast } from "../ui.js";

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

export const adminView = {
  id: "admin",
  title: "Account",
  subtitle: "Kelola profil, password, dan administrasi pengguna.",
  async mount(root, { apis, state }) {
    const isAdmin = state.user?.is_admin || false;

    root.innerHTML = `
      <div class="grid grid-2">
        <section class="panel" id="profile-panel">
          <div class="panel-header">
            <h3>Profil Saya</h3>
          </div>
          <div id="profile-content"><span class="dim"><span class="spinner"></span> Memuat...</span></div>
        </section>

        <section class="panel" id="password-panel">
          <div class="panel-header">
            <h3>Ubah Password</h3>
          </div>
          <form id="change-password-form" class="stack-md">
            <div>
              <label class="field-label" for="cp-current">Password Saat Ini</label>
              <input id="cp-current" type="password" required autocomplete="current-password" />
            </div>
            <div>
              <label class="field-label" for="cp-new">Password Baru</label>
              <input id="cp-new" type="password" required minlength="8" autocomplete="new-password" />
            </div>
            <div>
              <label class="field-label" for="cp-confirm">Konfirmasi Password Baru</label>
              <input id="cp-confirm" type="password" required minlength="8" autocomplete="new-password" />
            </div>
            <button class="btn btn-primary" type="submit">Ubah Password</button>
          </form>
          <p id="cp-message" class="message hidden"></p>
        </section>
      </div>

      ${isAdmin ? `
      <section class="panel">
        <div class="panel-header">
          <h3>Register User Baru</h3>
        </div>
        <form id="register-user-form" class="grid grid-3">
          <div>
            <label class="field-label" for="reg-username">Username</label>
            <input id="reg-username" required />
          </div>
          <div>
            <label class="field-label" for="reg-email">Email</label>
            <input id="reg-email" type="email" required />
          </div>
          <div>
            <label class="field-label" for="reg-password">Password</label>
            <input id="reg-password" type="password" minlength="6" required />
          </div>
          <div style="grid-column:1/-1;">
            <button class="btn btn-primary" type="submit">Register</button>
          </div>
        </form>
      </section>

      <section class="panel">
        <div class="panel-header">
          <h3>User List</h3>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Username</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Quota</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody id="users-body">
              <tr><td colspan="6" class="dim"><span class="spinner"></span> Memuat...</td></tr>
            </tbody>
          </table>
        </div>
      </section>
      ` : ""}
    `;

    // ── Load profile ──
    const profileContent = root.querySelector("#profile-content");
    async function loadProfile() {
      try {
        const me = await apis.auth.me();
        state.user = me;
        const quota = me.quota_instances || 0;
        profileContent.innerHTML = `
          <div style="display:flex;align-items:center;gap:16px;margin-bottom:14px;">
            <div style="width:54px;height:54px;border-radius:50%;background:linear-gradient(135deg,#60a5fa,#818cf8);display:grid;place-items:center;font-size:20px;font-weight:700;color:#fff;flex-shrink:0;">
              ${(me.username || "?").slice(0, 2).toUpperCase()}
            </div>
            <div>
              <div style="font-size:18px;font-weight:700;">${escapeHtml(me.username)} ${me.is_admin ? '<span class="badge badge-blue" style="font-size:10px;">admin</span>' : ""}</div>
              <div class="muted" style="font-size:13px;">${escapeHtml(me.email)}</div>
            </div>
          </div>
          <div class="stack-sm" style="max-width:300px;">
            <div class="field-row">
              <span class="muted">Instance Quota</span>
              <strong>${quota}</strong>
            </div>
            <div class="field-row">
              <span class="muted">User ID</span>
              <code class="mono" style="font-size:11px;">${escapeHtml(me.id)}</code>
            </div>
          </div>
          ${!me.is_admin && quota <= 3 ? `<p class="muted" style="margin-top:10px;font-size:12px;">Butuh quota lebih? Hubungi administrator.</p>` : ""}
        `;
      } catch (error) {
        profileContent.innerHTML = `<p class="message error">${message(error)}</p>`;
      }
    }

    // ── Change password ──
    const cpForm = root.querySelector("#change-password-form");
    const cpMsg = root.querySelector("#cp-message");

    cpForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const current = root.querySelector("#cp-current").value;
      const newPw = root.querySelector("#cp-new").value;
      const confirm = root.querySelector("#cp-confirm").value;

      if (newPw !== confirm) {
        cpMsg.className = "message error";
        cpMsg.textContent = "Password baru dan konfirmasi tidak cocok.";
        return;
      }
      if (newPw.length < 8) {
        cpMsg.className = "message error";
        cpMsg.textContent = "Password baru harus minimal 8 karakter.";
        return;
      }

      cpMsg.className = "message hidden";
      try {
        await apis.auth.changePassword(current, newPw);
        cpMsg.className = "message ok";
        cpMsg.textContent = "Password berhasil diubah.";
        cpForm.reset();
      } catch (error) {
        cpMsg.className = "message error";
        cpMsg.textContent = message(error);
      }
    });

    // ── Admin-only sections ──
    if (isAdmin) {
      const usersBody = root.querySelector("#users-body");
      async function loadUsers() {
        try {
          const usersPayload = await apis.admin.listUsers();
          const users = usersPayload.users || [];
          if (users.length === 0) {
            usersBody.innerHTML = `<tr><td colspan="6" class="dim">Tidak ada user.</td></tr>`;
            return;
          }
          usersBody.innerHTML = users
            .map(
              (item) => `
                <tr>
                  <td><strong>${escapeHtml(item.username)}</strong></td>
                  <td>${escapeHtml(item.email)}</td>
                  <td>${item.is_admin ? '<span class="badge badge-blue" style="font-size:10px;">admin</span>' : '<span class="muted">user</span>'}</td>
                  <td>${item.is_active ? '<span class="badge badge-green" style="font-size:10px;">active</span>' : '<span class="badge badge-dim" style="font-size:10px;">inactive</span>'}</td>
                  <td>${item.quota_instances}</td>
                  <td class="muted">${toLocalDate(item.created_at)}</td>
                </tr>
              `,
            )
            .join("");
        } catch (error) {
          usersBody.innerHTML = `<tr><td colspan="6" class="dim">${message(error)}</td></tr>`;
        }
      }

      root.querySelector("#register-user-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const payload = {
          username: root.querySelector("#reg-username").value.trim(),
          email: root.querySelector("#reg-email").value.trim(),
          password: root.querySelector("#reg-password").value,
        };
        try {
          await apis.auth.register(payload);
          toast("User berhasil didaftarkan.");
          event.target.reset();
          await loadUsers();
        } catch (error) {
          toast(message(error), "error");
        }
      });

      await loadUsers();
    }

    await loadProfile();
    return () => {};
  },
};
