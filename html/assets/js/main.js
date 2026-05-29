import { adminApi, auth, catalogApi, computeApi, monitorApi, networkApi, storageApi } from "./api.js";
import state from "./state.js";
import { toast } from "./ui.js";
import { getView } from "./views/index.js";

const apis = {
  auth,
  admin: adminApi,
  monitor: monitorApi,
  catalog: catalogApi,
  compute: computeApi,
  network: networkApi,
  storage: storageApi,
};

const elements = {
  loginScreen: document.getElementById("login-screen"),
  appShell: document.getElementById("app-shell"),
  loginForm: document.getElementById("login-form"),
  loginError: document.getElementById("login-error"),
  loginSubmit: document.getElementById("login-submit"),
  userChip: document.getElementById("user-chip"),
  logoutBtn: document.getElementById("logout-btn"),
  refreshViewBtn: document.getElementById("refresh-view"),
  viewTitle: document.getElementById("view-title"),
  viewSubtitle: document.getElementById("view-subtitle"),
  viewRoot: document.getElementById("view-root"),
  navItems: Array.from(document.querySelectorAll(".nav-item")),
  monitorBtn: document.getElementById("open-monitor"),
  storageBtn: document.getElementById("open-storage"),
  docsBtn: document.getElementById("open-docs"),
};

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
  elements.viewSubtitle.textContent = nextView.subtitle;

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
    });
    state.activeCleanup = typeof cleanup === "function" ? cleanup : null;
  } catch (error) {
    elements.viewRoot.innerHTML = `
      <section class="panel">
        <p class="message error">${error instanceof Error ? error.message : String(error)}</p>
      </section>
    `;
  }
}

async function bootstrapApp() {
  const me = await apis.auth.me();
  state.user = me;
  elements.userChip.textContent = `${me.username}${me.is_admin ? " (admin)" : ""}`;

  const adminNav = elements.navItems.find((item) => item.dataset.view === "admin");
  if (adminNav) {
    adminNav.classList.toggle("hidden", !me.is_admin);
  }
  const monitoringNav = elements.navItems.find((item) => item.dataset.view === "monitoring");
  if (monitoringNav) {
    monitoringNav.classList.toggle("hidden", !me.is_admin);
  }
  elements.monitorBtn.classList.toggle("hidden", !me.is_admin);

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
  apis.auth.clear();
  setLoggedOutUI();
}

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
  elements.loginSubmit.textContent = "Masuk...";
  try {
    await apis.auth.login(username, password);
    await bootstrapApp();
  } catch (error) {
    showLoginError(error instanceof Error ? error.message : String(error));
  } finally {
    elements.loginSubmit.disabled = false;
    elements.loginSubmit.textContent = "Masuk";
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
