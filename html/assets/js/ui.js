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
  const duration = type === "error" ? 5000 : 2500;
  window.setTimeout(() => {
    node.style.opacity = "0";
    node.style.transform = "translateX(20px)";
    node.style.transition = "all 0.3s ease";
    window.setTimeout(() => node.remove(), 300);
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
        <button class="btn btn-inline btn-ghost" data-close>✕</button>
      </div>
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-foot"></div>
    </div>
  `;

  const close = () => {
    wrapper.style.opacity = "0";
    wrapper.querySelector(".modal").style.transform = "scale(0.96) translateY(8px)";
    wrapper.querySelector(".modal").style.transition = "transform 0.15s ease";
    wrapper.style.transition = "opacity 0.15s ease";
    window.setTimeout(() => wrapper.remove(), 150);
  };
  wrapper.addEventListener("click", (event) => {
    if (event.target === wrapper) close();
  });
  wrapper.querySelector("[data-close]").addEventListener("click", close);

  const footer = wrapper.querySelector(".modal-foot");
  if (actions.length === 0) {
    footer.remove();
  } else {
    actions.forEach((action) => {
      const button = document.createElement("button");
      button.className = action.className || "btn";
      button.textContent = action.label;
      button.addEventListener("click", () => action.onClick({ close, wrapper, button }));
      footer.appendChild(button);
    });
  }

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
