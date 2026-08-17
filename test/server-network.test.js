import assert from "node:assert/strict";
import test from "node:test";

const networkModule = await import("../server-network.js").catch(() => ({}));

test("personal fallback binds only to IPv4 loopback", () => {
  assert.equal(typeof networkModule.listenerHost, "function");
  assert.equal(networkModule.listenerHost(true), "127.0.0.1");
});

test("production keeps the platform-compatible default bind", () => {
  assert.equal(typeof networkModule.listenerHost, "function");
  assert.equal(networkModule.listenerHost(false), undefined);
});
