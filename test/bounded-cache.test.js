import assert from "node:assert/strict";
import test from "node:test";

const cacheModule = await import("../bounded-cache.js").catch(() => ({}));

test("bounded TTL cache deletes expired entries before producing a replacement", async () => {
  assert.equal(typeof cacheModule.BoundedTtlCache, "function");
  let now = 1_000;
  let produces = 0;
  const cache = new cacheModule.BoundedTtlCache({ maxEntries: 2, now: () => now });

  assert.equal(await cache.getOrCreate("session:a", 100, async () => ++produces), 1);
  now = 1_099;
  assert.equal(await cache.getOrCreate("session:a", 100, async () => ++produces), 1);
  now = 1_100;
  assert.equal(await cache.getOrCreate("session:a", 100, async () => ++produces), 2);
  assert.equal(produces, 2);
});

test("bounded TTL cache evicts the least-recently-used live entry", async () => {
  assert.equal(typeof cacheModule.BoundedTtlCache, "function");
  const cache = new cacheModule.BoundedTtlCache({ maxEntries: 2, now: () => 1_000 });
  const produced = [];
  const create = (key) => async () => { produced.push(key); return key; };

  await cache.getOrCreate("a", 1_000, create("a"));
  await cache.getOrCreate("b", 1_000, create("b"));
  await cache.getOrCreate("a", 1_000, async () => { throw new Error("live hit must not produce"); });
  await cache.getOrCreate("c", 1_000, create("c"));
  await cache.getOrCreate("b", 1_000, create("b-reloaded"));

  assert.deepEqual(produced, ["a", "b", "c", "b-reloaded"]);
});

test("bounded TTL cache prunes all expired entries while enforcing its maximum", async () => {
  assert.equal(typeof cacheModule.BoundedTtlCache, "function");
  let now = 0;
  const cache = new cacheModule.BoundedTtlCache({ maxEntries: 2, now: () => now });
  await cache.getOrCreate("expired-a", 10, async () => "a");
  await cache.getOrCreate("expired-b", 10, async () => "b");
  now = 10;
  await cache.getOrCreate("live-c", 10, async () => "c");

  let reloaded = 0;
  await cache.getOrCreate("expired-a", 10, async () => { reloaded += 1; return "new-a"; });
  assert.equal(reloaded, 1);
});
