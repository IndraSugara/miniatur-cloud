import { adminApi, auth, catalogApi, computeApi, databaseApi, monitorApi, networkApi, storageApi } from "./api.js";
import state from "./state.js";
import { toast } from "./ui.js";
import { getView } from "./views/index.js";

const apis = {
  auth,
  admin: adminApi,
  monitor: monitorApi,
  catalog: catalogApi,
  compute: computeApi,
  database: databaseApi,
  network: networkApi,
  storage: storageApi,
};

const elements = {
  loginScreen: document.getElementById("login-screen"),
  appShell: document.getElementById("app-shell"),
  loginForm: document.getElementById("login-form"),
  loginModeText: document.getElementById("login-mode-text"),
  loginError: document.getElementById("login-error"),
  loginSubmit: document.getElementById("login-submit"),
  loginEmail: document.getElementById("login-email"),
  registerFields: document.getElementById("register-fields"),
  toggleRegister: document.getElementById("toggle-register"),
  userChip: document.getElementById("user-chip"),
  logoutBtn: document.getElementById("logout-btn"),
  refreshViewBtn: document.getElementById("refresh-view"),
  viewTitle: document.getElementById("view-title"),
  viewSubtitle: document.getElementById("view-subtitle"),
  viewRoot: document.getElementById("view-root"),
  navItems: Array.from(document.querySelectorAll(".nav-item")),
  monitorBtn: document.getElementById("open-monitor"),
  storageBtn: document.getElementById("open-storage-console"),
  docsBtn: document.getElementById("open-docs"),
  workspaceSelect: document.getElementById("workspace-select"),
};

let isRegisterMode = false;

/** Refresh the workspace dropdown from state.networks. */
function refreshWorkspaceDropdown() {
  const sel = elements.workspaceSelect;
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = `<option value="">All Resources</option>`;
  (state.networks || []).forEach((net) => {
    const opt = document.createElement("option");
    opt.value = net.id;
    opt.textContent = `${net.name} (${net.cidr || "auto"})`;
    if (net.id === current) opt.selected = true;
    sel.appendChild(opt);
  });
}

function setLoggedOutUI() {
  elements.loginScreen.classList.remove("hidden");
  elements.appShell.classList.add("hidden");
  elements.loginError.className = "message error hidden";
  elements.loginError.textContent = "";
}

function setLoggedInUI() {
  elements.loginScreen.classList.add("hidden");
  elements.appShell.classList.remove("hidden");
}

function showLoginError(message) {
  elements.loginError.className = "message error";
  elements.loginError.textContent = message;
}

async function mountView(viewId) {
  const nextView = getView(viewId);
  state.activeView = nextView.id;

  elements.navItems.forEach((item) => {
    item.classList.toggle("active", item.dataset.view === nextView.id);
  });

  elements.viewTitle.textContent = nextView.title;
  const wsNet = state.activeWorkspace
    ? (state.networks || []).find((n) => n.id === state.activeWorkspace)
    : null;
  elements.viewSubtitle.textContent = wsNet
    ? `${nextView.subtitle} — Workspace: ${wsNet.name}`
    : nextView.subtitle;

  if (typeof state.activeCleanup === "function") {
    state.activeCleanup();
    state.activeCleanup = null;
  }

  elements.viewRoot.innerHTML = `<section class="panel"><span class="dim">Loading ${nextView.title}...</span></section>`;

  try {
    const cleanup = await nextView.mount(elements.viewRoot, {
      apis,
      navigate: (targetView) => mountView(targetView),
      state,
      refreshWorkspaces: refreshWorkspaceDropdown,
    });
    state.activeCleanup = typeof cleanup === "function" ? cleanup : null;
  } catch (error) {
    elements.viewRoot.innerHTML = `
      <section class="panel">
        <p class="message error">${error instanceof Error ? error.message : String(error)}</p>
        <button id="error-retry-btn" class="btn btn-inline" style="margin-top:10px;">Coba Lagi</button>
      </section>
    `;
    document.getElementById("error-retry-btn")?.addEventListener("click", () => {
      mountView(viewId);
    });
  }
}

async function bootstrapApp() {
  const me = await apis.auth.me();
  state.user = me;

  // Show quota in user chip
  const quota = me.quota_instances || 0;
  elements.userChip.innerHTML = `${me.username}${me.is_admin ? " (admin)" : ""} <span class="dim" style="font-size:11px;" title="Instance quota">[quota: ${quota}]</span>`;

  // Admin-only nav/buttons
  const accountNav = elements.navItems.find((item) => item.dataset.view === "admin");
  if (accountNav) {
    // Always visible — shows Account for all users, Admin panel for admins
    accountNav.textContent = me.is_admin ? "Admin" : "Account";
  }
  const monitoringNav = elements.navItems.find((item) => item.dataset.view === "monitoring");
  if (monitoringNav) {
    monitoringNav.classList.toggle("hidden", !me.is_admin);
  }
  elements.monitorBtn.classList.toggle("hidden", !me.is_admin);
  // MinIO console only for admins (regular users use presigned URLs via Storage view)
  elements.storageBtn.classList.toggle("hidden", !me.is_admin);

  // Load networks for workspace dropdown
  try {
    const netsPayload = await apis.network.listNetworks();
    state.networks = netsPayload.networks || [];
  } catch {
    state.networks = [];
  }
  refreshWorkspaceDropdown();

  setLoggedInUI();
  await mountView(state.activeView);
}

function logout() {
  if (typeof state.activeCleanup === "function") {
    state.activeCleanup();
    state.activeCleanup = null;
  }
  state.user = null;
  state.activeView = "dashboard";
  state.activeWorkspace = null;
  state.networks = [];
  apis.auth.clear();
  setLoggedOutUI();
}

elements.toggleRegister.addEventListener("click", (event) => {
  event.preventDefault();
  isRegisterMode = !isRegisterMode;
  if (isRegisterMode) {
    elements.loginModeText.textContent = "Daftar akun baru untuk mengelola resource cloud.";
    elements.loginSubmit.textContent = "Daftar";
    elements.toggleRegister.textContent = "Sudah punya akun? Masuk";
    elements.registerFields.classList.remove("hidden");
    elements.loginEmail.required = true;
  } else {
    elements.loginModeText.textContent = "Masuk untuk mengelola compute, network, dan storage.";
    elements.loginSubmit.textContent = "Masuk";
    elements.toggleRegister.textContent = "Belum punya akun? Daftar";
    elements.registerFields.classList.add("hidden");
    elements.loginEmail.required = false;
  }
  elements.loginError.className = "message error hidden";
});

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(elements.loginForm);
  const username = String(form.get("username") || "").trim();
  const password = String(form.get("password") || "");
  if (!username || !password) {
    showLoginError("Username dan password wajib diisi.");
    return;
  }
  elements.loginSubmit.disabled = true;
  elements.loginSubmit.textContent = isRegisterMode ? "Mendaftar..." : "Masuk...";
  try {
    if (isRegisterMode) {
      const email = String(form.get("email") || "").trim();
      if (!email) {
        showLoginError("Email wajib diisi untuk pendaftaran.");
        elements.loginSubmit.disabled = false;
        elements.loginSubmit.textContent = "Daftar";
        return;
      }
      await apis.auth.register({ username, email, password });
      // Auto-login after registration
      await apis.auth.login(username, password);
      isRegisterMode = false;
      elements.registerFields.classList.add("hidden");
      elements.loginModeText.textContent = "Masuk untuk mengelola compute, network, dan storage.";
      elements.loginSubmit.textContent = "Masuk";
      elements.toggleRegister.textContent = "Belum punya akun? Daftar";
      await bootstrapApp();
    } else {
      await apis.auth.login(username, password);
      await bootstrapApp();
    }
  } catch (error) {
    showLoginError(error instanceof Error ? error.message : String(error));
  } finally {
    elements.loginSubmit.disabled = false;
    elements.loginSubmit.textContent = isRegisterMode ? "Daftar" : "Masuk";
  }
});

elements.logoutBtn.addEventListener("click", () => {
  logout();
  toast("Sesi logout berhasil.");
});

elements.navItems.forEach((item) => {
  item.addEventListener("click", () => {
    mountView(item.dataset.view);
  });
});

elements.refreshViewBtn.addEventListener("click", () => {
  mountView(state.activeView).catch((error) => {
    toast(error instanceof Error ? error.message : String(error), "error");
  });
});

// Workspace selector
elements.workspaceSelect.addEventListener("change", () => {
  state.activeWorkspace = elements.workspaceSelect.value || null;
  mountView(state.activeView).catch((error) => {
    toast(error instanceof Error ? error.message : String(error), "error");
  });
});

elements.monitorBtn.addEventListener("click", () => {
  window.open("/monitor/", "_blank", "noopener");
});
elements.storageBtn.addEventListener("click", () => {
  window.open("/storage-console/", "_blank", "noopener");
});
elements.docsBtn.addEventListener("click", () => {
  window.open("/api/docs", "_blank", "noopener");
});

async function init() {
  setLoggedOutUI();
  if (!apis.auth.hasToken()) return;

  try {
    await bootstrapApp();
  } catch (error) {
    apis.auth.clear();
    setLoggedOutUI();
    console.warn("Stored token invalid:", error);
  }
}

init();
