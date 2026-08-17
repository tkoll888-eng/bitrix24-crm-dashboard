import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

test("runtime presentation uses the platform favicon and safe upload icon", async () => {
  const [html, icon, iconStat] = await Promise.all([
    read("public/index.html"),
    read("public/app-icon.svg"),
    stat(path.join(root, "public/app-icon.svg")),
  ]);

  assert.match(html, /<link rel="icon" href="\/_gw\/icon">/);
  assert.ok(iconStat.size <= 256 * 1024, "app icon must be at most 256 KB");
  assert.match(icon, /^<\?xml[^>]*\?>\s*<svg\b[\s\S]*<\/svg>\s*$/);
  assert.doesNotMatch(icon, /<script\b|\son\w+\s*=|(?:href|src)\s*=\s*["'](?:data:|https?:|\/\/)/i);
});

test("runtime differentiates a missing placement session from local setup", async () => {
  const [html, app] = await Promise.all([read("public/index.html"), read("public/app.js")]);

  assert.match(html, /Откройте дашборд из левого меню Bitrix24/i);
  assert.match(html, /Локальная разработка не настроена/i);
  assert.doesNotMatch(html, /vibe_api_/i);
  assert.match(app, /connected/);
  assert.match(app, /configured/);
  assert.match(app, /authMode/);
  assert.match(app, /placement-guidance/);
  assert.match(app, /local-setup-guidance/);
  assert.match(app, /authMode === "placement"/);
});

test("runtime routes every dynamic error message through text-safe rendering", async () => {
  const [html, app] = await Promise.all([read("public/index.html"), read("public/app.js")]);

  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
  assert.match(app, /import \{ renderErrorText \} from "\.\/render-safe\.js"/);
  assert.equal((app.match(/renderErrorText\(/g) || []).length, 3);
  assert.doesNotMatch(app, /\$\{e\.message\}/);
});

test("README documents placement deployment and local-only fallback boundaries", async () => {
  const readme = await read("README.md");

  for (const marker of [
    "BITRIX_APP_KEY",
    "X-Vibe-Authorization",
    "Authorization",
    "per-session cache isolation",
    "BITRIX_API_KEY",
    "BITRIX_ALLOW_PERSONAL_FALLBACK=true",
    "must not deploy BITRIX_API_KEY or .env",
    "LEFT_MENU",
    "existing server",
  ]) {
    assert.match(readme, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
});
