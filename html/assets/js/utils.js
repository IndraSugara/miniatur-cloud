export function toLocalDate(value) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString("id-ID", {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return String(value);
  }
}

export function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}

export function statusClass(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "available") return "running";
  if (normalized === "attached") return "pending";
  if (["running", "pending", "stopped", "terminated", "error"].includes(normalized)) {
    return normalized;
  }
  return "stopped";
}

export function html(strings, ...values) {
  return strings
    .map((part, index) => `${part}${values[index] == null ? "" : values[index]}`)
    .join("");
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function withLoading(button, text, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = text;
  return Promise.resolve(fn()).finally(() => {
    button.disabled = false;
    button.textContent = original;
  });
}

export function createOptionList(items, labelFn, valueFn, selectedValue = null) {
  return items
    .map((item) => {
      const value = valueFn(item);
      const selected = selectedValue === value ? "selected" : "";
      return `<option value="${escapeHtml(value)}" ${selected}>${escapeHtml(labelFn(item))}</option>`;
    })
    .join("");
}
