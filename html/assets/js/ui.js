function getToastRoot() {
  return document.getElementById("toast-root");
}

function getModalRoot() {
  return document.getElementById("modal-root");
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function toast(message, type = "ok") {
  const root = getToastRoot();
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  root.appendChild(node);
  const duration = type === "error" ? 5000 : 2000;
  window.setTimeout(() => {
    node.remove();
  }, duration);
}

export function showModal({ title, bodyHtml, actions = [] }) {
  const root = getModalRoot();
  const wrapper = document.createElement("div");
  wrapper.className = "modal-backdrop";
  wrapper.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <strong>${esc(title)}</strong>
        <button class="btn btn-inline btn-ghost" data-close>Close</button>
      </div>
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-foot"></div>
    </div>
  `;

  const close = () => wrapper.remove();
  wrapper.addEventListener("click", (event) => {
    if (event.target === wrapper) close();
  });
  wrapper.querySelector("[data-close]").addEventListener("click", close);

  const footer = wrapper.querySelector(".modal-foot");
  actions.forEach((action) => {
    const button = document.createElement("button");
    button.className = action.className || "btn";
    button.textContent = action.label;
    button.addEventListener("click", () => action.onClick({ close, wrapper }));
    footer.appendChild(button);
  });

  root.appendChild(wrapper);
  return { close, wrapper };
}

export function setMessage(element, message, type = "ok") {
  if (!message) {
    element.className = "message hidden";
    element.textContent = "";
    return;
  }
  element.className = `message ${type}`;
  element.textContent = message;
}
