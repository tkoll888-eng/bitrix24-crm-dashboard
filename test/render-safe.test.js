import assert from "node:assert/strict";
import test from "node:test";

const renderModule = await import("../public/render-safe.js").catch(() => ({}));

test("dynamic error messages are rendered through textContent", () => {
  assert.equal(typeof renderModule.renderErrorText, "function");
  let textContent = "";
  const element = {
    get textContent() { return textContent; },
    set textContent(value) { textContent = value; },
    set innerHTML(_) { throw new Error("innerHTML must not be used for errors"); },
  };

  renderModule.renderErrorText(element, "Could not load", new Error('<img src=x onerror="attack()">'));

  assert.equal(element.textContent, 'Could not load: <img src=x onerror="attack()">');
});
