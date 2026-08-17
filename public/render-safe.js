export function renderErrorText(element, prefix, error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  element.textContent = `${prefix}: ${message}`;
  element.classList?.add("empty");
}
