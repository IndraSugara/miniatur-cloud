import { escapeHtml, toLocalDate } from "../utils.js";
import { toast } from "../ui.js";

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

export const adminView = {
  id: "admin",
  title: "Admin",
  subtitle: "Kelola pengguna dan verifikasi role admin.",
  async mount(root, { apis }) {
    root.innerHTML = `
      <section class="panel">
        <h3>Register User</h3>
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
        <h3>Current User</h3>
        <pre id="me-box" class="mono dim">Loading...</pre>
      </section>

      <section class="panel">
        <h3>User List (Admin Only)</h3>
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
              <tr><td colspan="6" class="dim">Loading...</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    `;

    const meBox = root.querySelector("#me-box");
    const usersBody = root.querySelector("#users-body");

    async function load() {
      const me = await apis.auth.me();
      meBox.textContent = JSON.stringify(me, null, 2);

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
                <td>${escapeHtml(item.username)}</td>
                <td>${escapeHtml(item.email)}</td>
                <td>${item.is_admin ? '<span class="badge-admin">admin</span>' : "user"}</td>
                <td>${item.is_active ? "active" : "inactive"}</td>
                <td>${item.quota_instances}</td>
                <td>${toLocalDate(item.created_at)}</td>
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
        await load();
      } catch (error) {
        toast(message(error), "error");
      }
    });

    await load();
    return () => {};
  },
};
