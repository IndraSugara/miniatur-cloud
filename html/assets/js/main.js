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
  // New shell elements
  sidebar: document.getElementById("sidebar"),
  sidebarToggle: document.getElementById("sidebar-toggle"),
  sidebarOverlay: document.getElementById("sidebar-overlay"),
  breadcrumbGroup: document.getElementById("breadcrumb-group"),
  breadcrumbPage: document.getElementById("breadcrumb-page"),
  userAvatar: document.getElementById("user-avatar"),
  userName: document.getElementById("user-name"),
  userChipTrigger: document.getElementById("user-chip-trigger"),
  userDropdown: document.getElementById("user-dropdown"),
  navAccount: document.getElementById("nav-account"),
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

/** Update breadcrumb from the active nav item. */
function updateBreadcrumb(viewId) {
  const navItem = elements.navItems.find((item) => item.dataset.view === viewId);
  const group = navItem?.dataset.group || "Overview";
  const page = navItem?.textContent.trim() || viewId;
  elements.breadcrumbGroup.textContent = group;
  elements.breadcrumbPage.textContent = page;
}

/** Close sidebar on mobile. */
function closeSidebar() {
  elements.sidebar.classList.remove("open");
  elements.sidebarOverlay.classList.remove("show");
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

  updateBreadcrumb(nextView.id);

  if (typeof state.activeCleanup === "function") {
    state.activeCleanup();
    state.activeCleanup = null;
  }

  // Add view-enter animation
  elements.viewRoot.className = "view-root";
  elements.viewRoot.innerHTML = `<section class="panel"><span class="dim"><span class="spinner"></span> Loading ${nextView.title}...</span></section>`;

  try {
    const cleanup = await nextView.mount(elements.viewRoot, {
      apis,
      navigate: (targetView) => mountView(targetView),
      state,
      refreshWorkspaces: refreshWorkspaceDropdown,
    });
    state.activeCleanup = typeof cleanup === "function" ? cleanup : null;
    elements.viewRoot.classList.add("view-enter");
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

  // Close sidebar on mobile after navigation
  closeSidebar();
}

async function bootstrapApp() {
  const me = await apis.auth.me();
  state.user = me;

  // Update user chip
  const initials = (me.username || "?").slice(0, 2).toUpperCase();
  elements.userAvatar.textContent = initials;
  elements.userName.textContent = me.username + (me.is_admin ? " (admin)" : "");

  // Admin-only nav/buttons
  const accountNav = elements.navItems.find((item) => item.dataset.view === "admin");
  if (accountNav) {
    const label = accountNav.querySelector(".nav-icon");
    const text = me.is_admin ? "Admin" : "Account";
    // Replace text node only, keep icon
    accountNav.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
        node.textContent = "\n              " + text + "\n            ";
      }
    });
  }

  const monitoringNav = elements.navItems.find((item) => item.dataset.view === "monitoring");
  if (monitoringNav) {
    monitoringNav.classList.toggle("hidden", !me.is_admin);
  }
  elements.monitorBtn.classList.toggle("hidden", !me.is_admin);
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
  closeUserDropdown();
}

// ── Login/Register Toggle ──────────────────────────────────────
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
    elements.loginModeText.textContent = "Masuk untuk mengelola compute, network, database, dan storage.";
    elements.loginSubmit.textContent = "Masuk";
    elements.toggleRegister.textContent = "Belum punya akun? Daftar";
    elements.registerFields.classList.add("hidden");
    elements.loginEmail.required = false;
  }
  elements.loginError.className = "message error hidden";
});

// ── Login Submit ───────────────────────────────────────────────
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
      await apis.auth.login(username, password);
      isRegisterMode = false;
      elements.registerFields.classList.add("hidden");
      elements.loginModeText.textContent = "Masuk untuk mengelola compute, network, database, dan storage.";
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

// ── Logout ─────────────────────────────────────────────────────
elements.logoutBtn.addEventListener("click", () => {
  logout();
  toast("Sesi logout berhasil.");
});

// ── Navigation ─────────────────────────────────────────────────
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

// ── Workspace selector ─────────────────────────────────────────
elements.workspaceSelect.addEventListener("change", () => {
  state.activeWorkspace = elements.workspaceSelect.value || null;
  mountView(state.activeView).catch((error) => {
    toast(error instanceof Error ? error.message : String(error), "error");
  });
});

// ── External links ─────────────────────────────────────────────
elements.monitorBtn.addEventListener("click", () => {
  window.open("/monitor/", "_blank", "noopener");
  closeUserDropdown();
});
elements.storageBtn.addEventListener("click", () => {
  window.open("/storage-console/", "_blank", "noopener");
  closeUserDropdown();
});
elements.docsBtn.addEventListener("click", () => {
  window.open("/api/docs", "_blank", "noopener");
  closeUserDropdown();
});

// ── Account nav from dropdown ──────────────────────────────────
elements.navAccount?.addEventListener("click", () => {
  mountView("admin");
  closeUserDropdown();
});

// ── Sidebar toggle (mobile) ───────────────────────────────────
elements.sidebarToggle?.addEventListener("click", () => {
  elements.sidebar.classList.toggle("open");
  elements.sidebarOverlay.classList.toggle("show");
});

elements.sidebarOverlay?.addEventListener("click", () => {
  closeSidebar();
});

// ── User dropdown toggle ──────────────────────────────────────
function closeUserDropdown() {
  elements.userDropdown.classList.add("hidden");
}

elements.userChipTrigger?.addEventListener("click", (event) => {
  event.stopPropagation();
  elements.userDropdown.classList.toggle("hidden");
});

document.addEventListener("click", (event) => {
  if (!elements.userDropdown.classList.contains("hidden")) {
    if (!event.target.closest("#user-menu")) {
      closeUserDropdown();
    }
  }
});

// ── Init ───────────────────────────────────────────────────────
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
